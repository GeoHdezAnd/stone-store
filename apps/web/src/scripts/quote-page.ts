import {
  FOLIO_PATTERN,
  SOLD_BY_UNITS,
  createQuoteRequestSchema,
  type SoldByUnit,
} from '@canteras/shared';
import {
  clearItems,
  getItems,
  isPersistent,
  onExternalChange,
  removeItem,
  updateItem,
  type QuoteListItem,
} from './quote-list';
import { parseQuantity } from './quantity';
import { buildWhatsAppUrl } from './whatsapp';

// Página /quote/: lista editable + formulario de cotización (CLAUDE.md 5.1, pasos 4 a 7).
// Reglas:
//  - La validación es el MISMO `createQuoteRequestSchema` que usa el servidor (packages/shared);
//    aquí solo se arma el cuerpo y se asignan los errores a cada campo.
//  - Nunca se vuelca texto del servidor en el DOM ni se usa innerHTML: solo `textContent`.
//  - Nada de datos personales en consola ni en URLs.

interface StoneInfo {
  id: string;
  nombre: string;
  vendidaPor: SoldByUnit[];
  espesoresCm: number[];
  acabados: string[];
}

const API_URL = (import.meta.env.PUBLIC_API_URL ?? '').trim().replace(/\/+$/, '');
const SITE_KEY = (import.meta.env.PUBLIC_TURNSTILE_SITE_KEY ?? '').trim();
/** Convención: con esta «clave» no se carga Turnstile y se envía el token que acepta Floci. */
const FAKE_TURNSTILE_KEY = 'test-pass';
const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const REQUEST_TIMEOUT_MS = 20_000;

const UNIT_OPTIONS: Readonly<Record<SoldByUnit, string>> = {
  m2: 'm²',
  pieza: 'Piezas',
  tonelada: 'Toneladas',
};

const root = document.querySelector<HTMLElement>('[data-quote-app]');
if (root) init(root);

function q<T extends HTMLElement>(scope: ParentNode, selector: string): T {
  const el = scope.querySelector<T>(selector);
  if (!el) throw new Error(`Falta el elemento ${selector}`);
  return el;
}

function init(app: HTMLElement): void {
  const stones = new Map<string, StoneInfo>(
    (JSON.parse(app.dataset['stones'] ?? '[]') as StoneInfo[]).map((s) => [s.id, s]),
  );
  const whatsapp = app.dataset['whatsapp'] ?? '';
  const form = q<HTMLFormElement>(app, '[data-quote-form]');
  const formView = q(app, '[data-view="form"]');
  const doneView = q(app, '[data-view="done"]');
  const itemsList = q<HTMLOListElement>(app, '[data-items]');
  const emptyMsg = q(app, '[data-empty]');
  const listTitle = q(app, '[data-list-title]');
  const status = q(app, '[data-form-status]');
  const submit = q<HTMLButtonElement>(app, '[data-submit]');
  const waLink = q<HTMLAnchorElement>(app, '[data-whatsapp-link]');

  // ---------- Configuración ----------
  const apiConfigured = API_URL !== '';
  // `test-pass` solo vale como modo de prueba con una API local (Floci); con cualquier otra API se
  // trata como clave no configurada, para que un build real no envíe un token falso.
  const localApi =
    /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/|$)/.test(API_URL) ||
    API_URL.startsWith('/_aws');
  const fakeCaptcha = SITE_KEY === FAKE_TURNSTILE_KEY && localApi;
  const captchaConfigured = SITE_KEY !== '' && (SITE_KEY !== FAKE_TURNSTILE_KEY || localApi);
  const canSubmit = apiConfigured && captchaConfigured;
  if (!canSubmit) q(app, '[data-config-warning]').hidden = false;
  // El botón viene deshabilitado en el HTML: sin JS no hay forma de enviar el formulario.
  submit.disabled = !canSubmit;
  if (!isPersistent()) q(app, '[data-persist-warning]').hidden = false;

  // ---------- Errores por campo ----------
  const errorEl = (id: string) => document.getElementById(id);

  function setError(controlId: string, errorId: string, message: string | null): void {
    const control = document.getElementById(controlId);
    const error = errorEl(errorId);
    if (message === null) {
      control?.removeAttribute('aria-invalid');
      if (error) {
        error.textContent = '';
        error.hidden = true;
      }
      return;
    }
    // El contenedor del widget no es un control: solo se muestra el mensaje (role="alert").
    if (controlId !== 'turnstile-widget') control?.setAttribute('aria-invalid', 'true');
    if (error) {
      error.textContent = message;
      error.hidden = false;
    }
  }

  function clearErrors(): void {
    form
      .querySelectorAll('[aria-invalid="true"]')
      .forEach((el) => el.removeAttribute('aria-invalid'));
    form.querySelectorAll<HTMLElement>('.error').forEach((el) => {
      el.textContent = '';
      el.hidden = true;
    });
    status.hidden = true;
    status.textContent = '';
  }

  /** `customer.nombre`, `items[0].cantidad`: mismo formato que el servidor devuelve en `issues`. */
  function pathKey(path: readonly PropertyKey[]): string {
    let out = '';
    for (const part of path) {
      if (typeof part === 'number') out += `[${part}]`;
      else out += out === '' ? String(part) : `.${String(part)}`;
    }
    return out;
  }

  const FIELD_BY_PATH: Readonly<Record<string, string>> = {
    'customer.nombre': 'f-nombre',
    'customer.telefono': 'f-telefono',
    'customer.correo': 'f-correo',
    'works.lugar': 'f-lugar',
    'works.codigoPostal': 'f-cp',
    'works.uso': 'f-uso',
    'works.notas': 'f-notas',
    consent: 'f-consent',
  };

  /** Resuelve la ruta de un error a `[idDelControl, idDelMensaje]`; `undefined` si no hay campo. */
  function targetFor(key: string, sentIds: readonly string[]): [string, string] | undefined {
    const direct = FIELD_BY_PATH[key];
    if (direct) return [direct, `${direct}-error`];
    if (key === 'turnstileToken') return ['turnstile-widget', 'f-turnstile-error'];
    if (key === 'items') return ['items-error', 'items-error'];
    const m = /^items\[(\d+)\]\.?(\w*)$/.exec(key);
    if (m) {
      const stoneId = sentIds[Number(m[1])];
      if (!stoneId) return ['items-error', 'items-error'];
      const field = m[2];
      if (field === 'cantidad')
        return [`item-${stoneId}-cantidad`, `item-${stoneId}-cantidad-error`];
      if (field === 'unidad') return [`item-${stoneId}-unidad`, `item-${stoneId}-unidad-error`];
      if (field === 'espesorCm')
        return [`item-${stoneId}-espesor`, `item-${stoneId}-espesor-error`];
      return [`item-${stoneId}-cantidad`, `item-${stoneId}-cantidad-error`];
    }
    return undefined;
  }

  // El resumen es `role="alert"`: se anuncia solo, sin mover el foco (evita el doble anuncio).
  function showStatus(message: string): void {
    status.textContent = message;
    status.hidden = false;
    status.scrollIntoView({ block: 'center' });
  }

  /** Foco al primer control inválido (en orden del documento); si no hay, al resumen. */
  function focusFirstProblem(): void {
    const first = form.querySelector<HTMLElement>('[aria-invalid="true"]');
    if (first) first.focus();
  }

  // ---------- Lista de piedras ----------
  function makeField(
    labelText: string,
    control: HTMLElement,
    errorId: string,
    hintText?: string,
  ): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    const label = document.createElement('label');
    label.htmlFor = control.id;
    label.textContent = labelText;
    const error = document.createElement('span');
    error.className = 'error';
    error.id = errorId;
    error.hidden = true;
    if (hintText) {
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.id = `${errorId}-hint`;
      hint.textContent = hintText;
      control.setAttribute('aria-describedby', `${hint.id} ${errorId}`);
      wrap.append(label, control, hint, error);
      return wrap;
    }
    control.setAttribute('aria-describedby', errorId);
    wrap.append(label, control, error);
    return wrap;
  }

  function renderItems(): void {
    // Las piedras que ya no están en el catálogo se descartan: el servidor las rechazaría.
    for (const stale of getItems().filter((i) => !stones.has(i.stoneId))) removeItem(stale.stoneId);
    // Un acabado que la piedra ya no ofrece se quita (igual que unidad y espesor, que se normalizan
    // al dibujar la fila).
    for (const i of liveItems()) {
      if (i.acabado !== undefined && !stones.get(i.stoneId)!.acabados.includes(i.acabado)) {
        updateItem(i.stoneId, { acabado: undefined });
      }
    }
    const items = liveItems();
    itemsList.replaceChildren();
    listTitle.textContent = `Tu lista · ${items.length} ${items.length === 1 ? 'piedra' : 'piedras'}`;
    emptyMsg.hidden = items.length > 0;
    for (const item of items) itemsList.append(renderItem(item, stones.get(item.stoneId)!));
    refreshWhatsApp();
  }

  /** Piedras de la lista que siguen en el catálogo (nunca revienta con una piedra retirada). */
  function liveItems(): QuoteListItem[] {
    return getItems().filter((i) => stones.has(i.stoneId));
  }

  function renderItem(item: QuoteListItem, info: StoneInfo): HTMLElement {
    const li = document.createElement('li');
    li.className = 'quote-item';

    const head = document.createElement('div');
    head.className = 'quote-item__head';
    const title = document.createElement('h3');
    title.className = 'quote-item__name';
    title.textContent = info.nombre;
    if (item.acabado) {
      const finish = document.createElement('span');
      finish.className = 'quote-item__finish';
      finish.textContent = `Acabado: ${item.acabado}`;
      title.append(finish);
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn-ghost';
    remove.textContent = 'Quitar';
    remove.setAttribute('aria-label', `Quitar ${info.nombre} de la lista`);
    remove.addEventListener('click', () => {
      removeItem(item.stoneId);
      renderItems();
      (
        itemsList.querySelector<HTMLElement>('input, select, button') ??
        form.querySelector<HTMLElement>('#f-nombre')
      )?.focus();
    });
    head.append(title, remove);

    const fields = document.createElement('div');
    fields.className = 'quote-item__fields';

    const qty = document.createElement('input');
    qty.className = 'input';
    qty.id = `item-${item.stoneId}-cantidad`;
    qty.inputMode = 'decimal';
    qty.autocomplete = 'off';
    qty.value = item.cantidad !== undefined ? String(item.cantidad) : '';
    qty.dataset['stoneId'] = item.stoneId;
    qty.dataset['field'] = 'cantidad';

    const unit = document.createElement('select');
    unit.className = 'input';
    unit.id = `item-${item.stoneId}-unidad`;
    unit.dataset['stoneId'] = item.stoneId;
    unit.dataset['field'] = 'unidad';
    const units = SOLD_BY_UNITS.filter((u) => info.vendidaPor.includes(u));
    for (const u of units) {
      const opt = document.createElement('option');
      opt.value = u;
      opt.textContent = UNIT_OPTIONS[u];
      unit.append(opt);
    }
    unit.value = item.unidad && units.includes(item.unidad) ? item.unidad : (units[0] ?? 'm2');

    const thickness = document.createElement('select');
    thickness.className = 'input';
    thickness.id = `item-${item.stoneId}-espesor`;
    thickness.dataset['stoneId'] = item.stoneId;
    thickness.dataset['field'] = 'espesorCm';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'Elige el espesor';
    thickness.append(none);
    for (const cm of info.espesoresCm) {
      const opt = document.createElement('option');
      opt.value = String(cm);
      opt.textContent = `${cm} cm`;
      thickness.append(opt);
    }
    if (item.espesorCm !== undefined && info.espesoresCm.includes(item.espesorCm)) {
      thickness.value = String(item.espesorCm);
    }

    const qtyField = makeField(
      'Cantidad aproximada',
      qty,
      `item-${item.stoneId}-cantidad-error`,
      'Solo números, por ejemplo 1500 o 1,500.5',
    );
    const unitField = makeField('Unidad', unit, `item-${item.stoneId}-unidad-error`);
    const thickField = makeField('Espesor', thickness, `item-${item.stoneId}-espesor-error`);
    thickField.hidden = unit.value !== 'm2';
    fields.append(qtyField, unitField, thickField);

    qty.addEventListener('input', () => {
      const n = parseQuantity(qty.value);
      updateItem(item.stoneId, { cantidad: Number.isFinite(n) && n > 0 ? n : undefined });
      refreshWhatsApp();
    });
    unit.addEventListener('change', () => {
      const u = unit.value as SoldByUnit;
      thickField.hidden = u !== 'm2';
      updateItem(item.stoneId, { unidad: u });
      refreshWhatsApp();
    });
    thickness.addEventListener('change', () => {
      const cm = Number(thickness.value);
      updateItem(item.stoneId, { espesorCm: thickness.value === '' ? undefined : cm });
    });

    li.append(head, fields);
    return li;
  }

  // ---------- WhatsApp ----------
  function currentItemsForMessage() {
    return liveItems().map((i) => ({
      nombre: stones.get(i.stoneId)?.nombre ?? i.nombre,
      acabado: i.acabado,
      cantidad: i.cantidad,
      unidad: i.unidad,
    }));
  }

  function refreshWhatsApp(): void {
    waLink.href = buildWhatsAppUrl(whatsapp, {
      items: currentItemsForMessage(),
      codigoPostal: q<HTMLInputElement>(form, '#f-cp').value.trim(),
    });
  }

  // ---------- Cuerpo del pedido desde el DOM ----------
  function buildPayload(token: string) {
    const val = (id: string) => q<HTMLInputElement>(form, `#${id}`).value;
    const items = liveItems().map((i) => {
      const unit = q<HTMLSelectElement>(form, `#item-${i.stoneId}-unidad`).value;
      const item: Record<string, unknown> = {
        stoneId: i.stoneId,
        cantidad: parseQuantity(q<HTMLInputElement>(form, `#item-${i.stoneId}-cantidad`).value),
        unidad: unit,
      };
      if (i.acabado) item['acabado'] = i.acabado;
      if (unit === 'm2') {
        const t = q<HTMLSelectElement>(form, `#item-${i.stoneId}-espesor`).value;
        if (t !== '') item['espesorCm'] = Number(t);
      }
      return item;
    });
    const works = {
      lugar: val('f-lugar'),
      codigoPostal: val('f-cp').trim(),
      // El esquema exige la clave `uso` (puede ir vacía).
      uso: val('f-uso'),
      notas: val('f-notas'),
    };
    return {
      customer: { nombre: val('f-nombre'), telefono: val('f-telefono'), correo: val('f-correo') },
      works,
      items,
      consent: q<HTMLInputElement>(form, '#f-consent').checked,
      website: q<HTMLInputElement>(form, '#f-website').value,
      turnstileToken: token,
    };
  }

  // ---------- Turnstile ----------
  // Render explícito (https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/):
  // script `api.js?render=explicit` y `turnstile.render(contenedor, { sitekey, callback, ... })`.
  // El script se carga SOLO en esta página y solo con una clave real.
  let token = fakeCaptcha ? FAKE_TURNSTILE_KEY : '';
  let widgetId: string | undefined;
  const widgetBox = q(app, '[data-turnstile]');
  const captchaNote = q(app, '[data-turnstile-note]');
  const setCaptchaError = (message: string | null) =>
    setError('turnstile-widget', 'f-turnstile-error', message);

  function renderWidget(): void {
    const api = window.turnstile;
    if (!api) return;
    widgetId = api.render(widgetBox, {
      sitekey: SITE_KEY,
      callback: (t: string) => {
        token = t;
        setCaptchaError(null);
      },
      'expired-callback': () => {
        token = '';
      },
      'error-callback': () => {
        token = '';
        setCaptchaError(
          'No pudimos cargar la verificación anti-spam. Recarga la página e inténtalo de nuevo.',
        );
      },
    });
  }

  function resetCaptcha(): void {
    if (fakeCaptcha) return;
    token = '';
    if (widgetId !== undefined) window.turnstile?.reset(widgetId);
  }

  if (fakeCaptcha) {
    widgetBox.hidden = true;
    captchaNote.textContent = 'Modo de prueba: la verificación anti-spam está simulada.';
    captchaNote.hidden = false;
  } else if (captchaConfigured) {
    const script = document.createElement('script');
    script.src = TURNSTILE_SRC;
    script.async = true;
    script.defer = true;
    script.addEventListener('load', renderWidget);
    script.addEventListener('error', () =>
      setCaptchaError(
        'No pudimos cargar la verificación anti-spam. Revisa tu conexión e inténtalo de nuevo.',
      ),
    );
    document.head.append(script);
  }

  // ---------- Envío ----------
  let submitting = false;

  function whatsappAlternative(): string {
    return 'Si el problema continúa, escríbenos por WhatsApp.';
  }

  form.addEventListener('input', (e) => {
    const t = e.target as HTMLElement;
    if (t.id === 'f-cp') refreshWhatsApp();
    // Al corregir un campo se limpia su error.
    if (t.getAttribute('aria-invalid') === 'true') {
      const err = t.getAttribute('aria-describedby');
      if (err) setError(t.id, err.split(' ').pop()!, null);
    }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (submitting || !apiConfigured || !captchaConfigured) return;
    void handleSubmit();
  });

  async function handleSubmit(): Promise<void> {
    clearErrors();
    const sentIds = liveItems().map((i) => i.stoneId);
    const parsed = createQuoteRequestSchema.safeParse(buildPayload(token));
    if (!parsed.success) {
      const seen = new Set<string>();
      for (const issue of parsed.error.issues) {
        const target = targetFor(pathKey(issue.path), sentIds);
        if (!target || seen.has(target[1])) continue;
        seen.add(target[1]);
        setError(target[0], target[1], issue.message);
      }
      const n = seen.size;
      showStatus(n === 1 ? 'Revisa el campo marcado.' : 'Revisa los campos marcados.');
      focusFirstProblem();
      return;
    }

    submitting = true;
    submit.disabled = true;
    submit.setAttribute('aria-busy', 'true');
    submit.textContent = 'Enviando…';
    try {
      const res = await fetch(`${API_URL}/quotes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parsed.data),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      await handleResponse(res, sentIds);
    } catch {
      // Red caída, tiempo agotado o CORS: no se registra nada (podría haber datos personales).
      resetCaptcha();
      showStatus(
        `No pudimos enviar tu solicitud. Revisa tu conexión e inténtalo de nuevo. ${whatsappAlternative()}`,
      );
    } finally {
      submitting = false;
      submit.disabled = !apiConfigured || !captchaConfigured;
      submit.removeAttribute('aria-busy');
      submit.textContent = 'Enviar solicitud';
    }
  }

  async function handleResponse(res: Response, sentIds: readonly string[]): Promise<void> {
    if (res.status === 201) {
      let folio: string | undefined;
      try {
        const body: unknown = await res.json();
        const candidate = (body as { folio?: unknown } | null)?.folio;
        if (typeof candidate === 'string' && FOLIO_PATTERN.test(candidate)) folio = candidate;
      } catch {
        // Respuesta sin JSON: se confirma igual, sin folio.
      }
      showDone(folio);
      return;
    }

    resetCaptcha();
    if (res.status === 422) {
      let issues: unknown;
      try {
        issues = ((await res.json()) as { issues?: unknown }).issues;
      } catch {
        issues = undefined;
      }
      let marked = 0;
      if (Array.isArray(issues)) {
        for (const issue of issues) {
          const path = (issue as { path?: unknown } | null)?.path;
          if (typeof path !== 'string') continue;
          const target = targetFor(path, sentIds);
          // El texto del servidor no se muestra: se usa un mensaje propio y fijo.
          if (target) {
            setError(target[0], target[1], 'Revisa este dato.');
            marked++;
          }
        }
      }
      showStatus(
        marked > 0
          ? 'Algunos datos no son válidos. Revisa los campos marcados.'
          : `Algunos datos no son válidos. Revísalos e inténtalo de nuevo. ${whatsappAlternative()}`,
      );
      focusFirstProblem();
      return;
    }
    if (res.status === 403) {
      showStatus('No pudimos verificar que eres una persona. Inténtalo de nuevo.');
      setCaptchaError('Completa la verificación anti-spam otra vez.');
      return;
    }
    if (res.status === 429) {
      showStatus(`Recibimos demasiadas solicitudes. Intenta más tarde. ${whatsappAlternative()}`);
      return;
    }
    // 400, 413, 415, 503, 5xx y cualquier otro código.
    showStatus(
      `No pudimos enviar tu solicitud en este momento. Inténtalo más tarde. ${whatsappAlternative()}`,
    );
  }

  function showDone(folio: string | undefined): void {
    const waItems = currentItemsForMessage();
    const cp = q<HTMLInputElement>(form, '#f-cp').value.trim();
    clearItems();
    form.reset();
    formView.hidden = true;
    doneView.hidden = false;
    if (folio) {
      q(doneView, '[data-folio]').textContent = folio;
      q(doneView, '[data-done-folio-wrap]').hidden = false;
    }
    q<HTMLAnchorElement>(doneView, '[data-done-whatsapp]').href = buildWhatsAppUrl(whatsapp, {
      items: waItems,
      codigoPostal: cp,
    });
    q(doneView, '[data-done-title]').focus();
  }

  // ---------- Arranque ----------
  // `?motivo=visita` precarga «Para qué es»; cualquier otro valor se ignora.
  try {
    if (new URLSearchParams(window.location.search).get('motivo') === 'visita') {
      q<HTMLSelectElement>(form, '#f-uso').value = 'Visita al patio';
    }
  } catch {
    // Sin acceso a la URL: no pasa nada.
  }

  renderItems();
  onExternalChange(() => {
    if (!submitting && doneView.hidden) renderItems();
  });
}

interface TurnstileApi {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      'expired-callback': () => void;
      'error-callback': () => void;
    },
  ): string;
  reset(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

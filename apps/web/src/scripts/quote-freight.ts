import type { SoldByUnit } from '@canteras/shared';
import '../styles/quote-freight.css';
import { buildWhatsAppUrl, type WhatsAppItem } from './whatsapp';

// Estimado de flete del formulario de /quote/ (CLAUDE.md 5.1 paso 5 y 7.1).
// Reglas:
//  - Solo se consulta con CP de 5 dígitos y TODAS las piedras con cantidad > 0 (y espesor en m²):
//    un estimado de una lista a medias subestimaría el peso.
//  - Debounce de 500 ms, `AbortController` para cancelar la petición anterior y un número de
//    secuencia para que una respuesta tardía jamás pise a una más nueva (condición de carrera).
//  - El estimado es informativo: nunca bloquea el envío. El servidor lo recalcula al guardar.
//  - Nada de datos del cliente en consola; el texto del servidor solo se muestra con `textContent`.

export const DEBOUNCE_MS = 500;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_SERVER_MESSAGE = 300;
const CP_RE = /^\d{5}$/;

/** Renglón tal como está en el formulario ahora mismo (todo puede estar a medias). */
export interface DraftItem {
  stoneId: string;
  nombre: string;
  acabado?: string | undefined;
  cantidad?: number | undefined;
  unidad: SoldByUnit;
  espesorCm?: number | undefined;
}

export interface DraftSnapshot {
  codigoPostal: string;
  items: readonly DraftItem[];
}

interface RequestBody {
  codigoPostal: string;
  items: { stoneId: string; cantidad: number; unidad: SoldByUnit; espesorCm?: number }[];
}

interface Estimate {
  estimadoMin: number;
  estimadoMax: number;
  pesoTotalKg: number;
  distanciaKm: number;
  camion: string;
  viajes: number;
  ejemplo: boolean;
}

const money = new Intl.NumberFormat('es-MX', {
  style: 'currency',
  currency: 'MXN',
  maximumFractionDigits: 0,
});
const number = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 1 });

/** Cuerpo de la petición, o el motivo por el que todavía no se puede estimar. */
export function toRequest(
  snapshot: DraftSnapshot,
): { ok: true; body: RequestBody } | { ok: false; reason: 'idle' | 'incomplete' } {
  if (!CP_RE.test(snapshot.codigoPostal)) return { ok: false, reason: 'idle' };
  if (snapshot.items.length === 0) return { ok: false, reason: 'idle' };
  const items: RequestBody['items'] = [];
  for (const i of snapshot.items) {
    if (i.cantidad === undefined || !Number.isFinite(i.cantidad) || i.cantidad <= 0) {
      return { ok: false, reason: 'incomplete' };
    }
    if (i.unidad === 'm2' && i.espesorCm === undefined) return { ok: false, reason: 'incomplete' };
    items.push({
      stoneId: i.stoneId,
      cantidad: i.cantidad,
      unidad: i.unidad,
      ...(i.unidad === 'm2' && i.espesorCm !== undefined ? { espesorCm: i.espesorCm } : {}),
    });
  }
  return { ok: true, body: { codigoPostal: snapshot.codigoPostal, items } };
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Valida la respuesta 200: no se pinta nada que no tenga la forma esperada. */
function parseEstimate(raw: unknown): Estimate | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    !isNum(r['estimadoMin']) ||
    !isNum(r['estimadoMax']) ||
    !isNum(r['pesoTotalKg']) ||
    !isNum(r['distanciaKm']) ||
    typeof r['camion'] !== 'string' ||
    r['camion'] === '' ||
    r['camion'].length > 80 ||
    !isNum(r['viajes']) ||
    !Number.isInteger(r['viajes']) ||
    r['viajes'] < 1
  ) {
    return null;
  }
  return {
    estimadoMin: r['estimadoMin'],
    estimadoMax: r['estimadoMax'],
    pesoTotalKg: r['pesoTotalKg'],
    distanciaKm: r['distanciaKm'],
    camion: r['camion'],
    viajes: r['viajes'],
    ejemplo: r['ejemplo'] === true,
  };
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export const NOTICE = 'Estimado sujeto a confirmación.';
const KEEP_SENDING = 'Puedes enviar tu solicitud de todos modos: te confirmaremos el flete.';

export interface FreightEstimator {
  /** Avisa que el formulario cambió (CP, cantidades, unidades, espesores, lista). */
  update(snapshot: DraftSnapshot): void;
}

export function createFreightEstimator(opts: {
  /** URL base de la API sin «/» final. */
  apiUrl: string;
  /** Región `aria-live` donde se pinta todo. */
  region: HTMLElement;
  /** Número de WhatsApp sin «+» (para el aviso de zona). */
  whatsapp: string;
}): FreightEstimator {
  const { apiUrl, region, whatsapp } = opts;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  /** Cada cambio y cada petición suben el número: solo la última puede pintar. */
  let seq = 0;
  /** Clave de lo último pedido con éxito o en curso (evita repetir la misma consulta). */
  let lastKey = '';
  let lastWasError = false;

  function cancelPending(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    controller?.abort();
    controller = undefined;
  }

  function show(...nodes: HTMLElement[]): void {
    region.replaceChildren(...nodes);
    region.removeAttribute('aria-busy');
  }

  function clear(): void {
    region.replaceChildren();
    region.removeAttribute('aria-busy');
  }

  function hint(text: string): void {
    show(el('p', 'freight__hint', text));
  }

  function renderEstimate(e: Estimate): void {
    const range = el(
      'p',
      'freight__range',
      e.estimadoMin === e.estimadoMax
        ? `${money.format(e.estimadoMin)} MXN`
        : `${money.format(e.estimadoMin)} a ${money.format(e.estimadoMax)} MXN`,
    );
    const facts = el('dl', 'freight__facts');
    const rows: [string, string][] = [
      ['Peso aproximado', `${number.format(e.pesoTotalKg)} kg`],
      ['Distancia', `${number.format(e.distanciaKm)} km`],
      ['Camión', e.camion],
      ['Viajes', String(e.viajes)],
    ];
    for (const [label, value] of rows) {
      const wrap = el('div');
      wrap.append(el('dt', undefined, label), el('dd', undefined, value));
      facts.append(wrap);
    }
    const nodes = [
      el('p', 'freight__hint', 'Flete estimado a tu código postal'),
      range,
      facts,
      el('p', 'freight__notice', NOTICE),
    ];
    if (e.ejemplo) nodes.push(el('p', 'freight__hint', 'Calculado con tarifas de ejemplo.'));
    show(...nodes);
  }

  function renderUnavailable(message: string): void {
    show(el('p', undefined, message), el('p', 'freight__hint', KEEP_SENDING));
  }

  function renderOutOfZone(message: string, snapshot: DraftSnapshot): void {
    const link = el('a', undefined, 'Escribir por WhatsApp');
    const items: WhatsAppItem[] = snapshot.items.map((i) => ({
      nombre: i.nombre,
      acabado: i.acabado,
      cantidad: i.cantidad,
      unidad: i.unidad,
    }));
    link.href = buildWhatsAppUrl(whatsapp, { items, codigoPostal: snapshot.codigoPostal });
    link.target = '_blank';
    link.rel = 'noopener';
    const wrap = el('p', 'freight__link');
    wrap.append(link);
    show(el('p', undefined, message), wrap, el('p', 'freight__hint', KEEP_SENDING));
  }

  /** Mensaje del 422: solo si es texto razonable; si no, uno propio. */
  function serverMessage(raw: unknown): string {
    const m = (raw as { message?: unknown } | null)?.message;
    return typeof m === 'string' && m.trim() !== '' && m.length <= MAX_SERVER_MESSAGE
      ? m.trim()
      : 'Esa ubicación o ese pedido queda fuera de nuestra zona de entrega: consúltanos por WhatsApp.';
  }

  async function run(snapshot: DraftSnapshot, body: RequestBody, mySeq: number): Promise<void> {
    const mine = new AbortController();
    controller = mine;
    const timeout = setTimeout(() => mine.abort(), REQUEST_TIMEOUT_MS);
    show(el('p', undefined, 'Calculando el estimado de flete…'));
    try {
      const res = await fetch(`${apiUrl}/freight/estimate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: mine.signal,
      });
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        json = undefined;
      }
      // Una respuesta vieja nunca pisa a una más nueva.
      if (mySeq !== seq) return;
      if (res.status === 200) {
        const estimate = parseEstimate(json);
        if (estimate) {
          lastWasError = false;
          renderEstimate(estimate);
        } else {
          lastWasError = true;
          renderUnavailable('No pudimos calcular el estimado por ahora.');
        }
        return;
      }
      lastWasError = res.status !== 422;
      if (res.status === 422) {
        const code = (json as { error?: unknown } | null)?.error;
        if (code === 'out_of_zone' || code === 'too_large') {
          renderOutOfZone(serverMessage(json), snapshot);
        } else {
          renderUnavailable('No pudimos calcular el estimado con esos datos.');
        }
      } else if (res.status === 400) {
        renderUnavailable(
          'No pudimos calcular el estimado con esos datos. Revisa el código postal y las cantidades.',
        );
      } else if (res.status === 429) {
        renderUnavailable(
          'Hay muchas consultas en este momento. Intenta de nuevo en unos minutos.',
        );
      } else if (res.status === 502) {
        renderUnavailable('No pudimos calcular la distancia a tu código postal por ahora.');
      } else {
        renderUnavailable('El estimado de flete no está disponible por ahora.');
      }
    } catch {
      // Red caída, tiempo agotado o cancelación. No se registra nada (podría haber datos del cliente).
      if (mySeq !== seq) return;
      lastWasError = true;
      renderUnavailable('No pudimos conectarnos para calcular el estimado.');
    } finally {
      clearTimeout(timeout);
      if (controller === mine) controller = undefined;
    }
  }

  return {
    update(snapshot: DraftSnapshot): void {
      const req = toRequest(snapshot);
      if (!req.ok) {
        seq++;
        cancelPending();
        lastKey = '';
        lastWasError = false;
        if (req.reason === 'incomplete') {
          hint(
            'Indica la cantidad de cada piedra (y el espesor si es en m²) para ver el estimado de flete.',
          );
        } else {
          clear();
        }
        return;
      }
      const key = JSON.stringify(req.body);
      // Misma consulta que ya se mostró (o está en curso): no se repite, salvo tras un error.
      if (key === lastKey && !lastWasError) return;
      lastKey = key;
      seq++;
      const mySeq = seq;
      cancelPending();
      region.setAttribute('aria-busy', 'true');
      timer = setTimeout(() => {
        timer = undefined;
        void run(snapshot, req.body, mySeq);
      }, DEBOUNCE_MS);
    },
  };
}

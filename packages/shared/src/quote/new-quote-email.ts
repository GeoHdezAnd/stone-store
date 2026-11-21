import { escapeHtml, publicSettingsSchema, type PublicSettings } from '../catalog/settings';
import type { QuoteEmail } from './email';
import { isValidRecipient } from './email';
import { fromHeader, oneLine } from './mail-headers';
import type { Quote } from './schema';

// Correos que se mandan al recibir una solicitud nueva (CLAUDE.md 5.1 pasos 7, 8 y 5.2 paso 1).
// Dominio puro: construye el mensaje, no envía nada. El texto plano NO se escapa y el HTML escapa
// TODO valor que venga del cliente. Los encabezados (asunto, remitente, nombres) van en una línea.

const quantity = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 2 });
const UNIT_LABELS: Readonly<Record<string, string>> = {
  m2: 'm²',
  pieza: 'pieza(s)',
  tonelada: 't',
};

function parseSettings(settings: PublicSettings): PublicSettings {
  const pub = publicSettingsSchema.safeParse(settings);
  if (!pub.success) throw new Error('La configuración del patio no es válida.');
  return pub.data;
}

function stoneLines(quote: Quote): string[] {
  return quote.items.map((item) => {
    const nombre = oneLine(item.acabado === '' ? item.nombre : `${item.nombre} (${item.acabado})`);
    const unit = UNIT_LABELS[item.unidad] ?? item.unidad;
    return `${nombre}: ${quantity.format(item.cantidad)} ${unit}`;
  });
}

/** `<br>` en lugar de saltos de línea, sobre texto YA escapado. */
const toHtml = (escaped: string): string => escaped.replace(/\r?\n/g, '<br>\n');

function wrapHtml(inner: string): string {
  return `<div style="font-family:Arial,sans-serif;line-height:1.5">${inner}</div>`;
}

/** Enlace al detalle en el dashboard: solo con una base http(s) simple; si no, sin enlace. */
function detailLink(adminBaseUrl: string | undefined, quoteId: string): string | null {
  if (adminBaseUrl === undefined) return null;
  const base = adminBaseUrl.replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s<>"'`\\]+$/.test(base)) return null;
  return `${base}/quotes/${quoteId}`;
}

const money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });

/**
 * Confirmación al cliente. El destinatario lo escribe cualquiera en un formulario público, así que
 * este correo es un posible relevo de phishing: NO lleva NINGÚN texto libre del cliente (ni nombre,
 * ni lugar, uso, notas o teléfono). Solo folio, piedras con el nombre del catálogo, cantidades, el
 * estimado de flete si existe y los datos del patio (todo lo decide el servidor).
 */
export function buildCustomerConfirmationEmail(input: {
  quote: Quote;
  publicSettings: PublicSettings;
}): QuoteEmail {
  const { quote } = input;
  const pub = parseSettings(input.publicSettings);
  if (!isValidRecipient(quote.customer.correo)) {
    throw new Error('El destinatario no es un correo válido.');
  }
  const lines = stoneLines(quote);
  const intro = 'Hola,';
  const body = [
    `Recibimos una solicitud de cotización con el folio ${quote.folio}. Guárdalo para cualquier consulta.`,
    'Piedras solicitadas:',
  ];
  const estimate =
    quote.freight === undefined
      ? null
      : `Estimado de flete: ${money.format(quote.freight.estimadoMin)} a ${money.format(quote.freight.estimadoMax)} MXN (estimado sujeto a confirmación).`;
  const promesa =
    estimate === null
      ? 'Un asesor te responderá en menos de 48 horas. Los precios y el flete se confirman en la cotización que recibirás; este correo no incluye importes.'
      : 'Un asesor te responderá en menos de 48 horas. Los precios y el flete se confirman en la cotización que recibirás.';
  const footerLines = [
    `— ${oneLine(pub.nombrePatio)}`,
    `Dirección: ${oneLine(pub.direccion)}`,
    `Horario: ${oneLine(pub.horario)}`,
    `WhatsApp: https://wa.me/${pub.whatsapp}`,
  ];

  const text = [
    intro,
    '',
    body[0],
    '',
    body[1],
    ...lines.map((l) => `- ${l}`),
    '',
    ...(estimate === null ? [] : [estimate, '']),
    promesa,
    '',
    ...footerLines,
    '',
  ].join('\n');

  const html = wrapHtml(
    [
      `<p>${escapeHtml(intro)}</p>`,
      `<p>${escapeHtml(body[0] as string)}</p>`,
      `<p>${escapeHtml(body[1] as string)}</p>`,
      `<ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`,
      ...(estimate === null ? [] : [`<p>${escapeHtml(estimate)}</p>`]),
      `<p>${escapeHtml(promesa)}</p>`,
      `<p>${footerLines.map((l) => escapeHtml(l)).join('<br>\n')}</p>`,
    ].join('\n'),
  );

  return {
    from: fromHeader(pub.nombrePatio, pub.correoRemitente),
    to: quote.customer.correo,
    subject: oneLine(`Recibimos tu solicitud de cotización ${quote.folio}`),
    text,
    html,
  };
}

/** Aviso al dueño: todos los datos de la solicitud y, si hay `adminBaseUrl`, el enlace al detalle. */
export function buildOwnerNotificationEmail(input: {
  quote: Quote;
  publicSettings: PublicSettings;
  /** Base del dashboard (p. ej. `https://admin.ejemplo.mx`). Sin ella el aviso va sin enlace. */
  adminBaseUrl?: string | undefined;
}): QuoteEmail {
  const { quote } = input;
  const pub = parseSettings(input.publicSettings);
  const { customer, works } = quote;
  const link = detailLink(input.adminBaseUrl, quote.quoteId);

  const head = `Nueva solicitud de cotización ${quote.folio}.`;
  const dataLines = [
    `Cliente: ${oneLine(customer.nombre)}`,
    `Teléfono: ${oneLine(customer.telefono)}`,
    `Correo: ${customer.correo}`,
    `Lugar de la obra: ${works.lugar}`,
    `Código postal: ${works.codigoPostal}`,
    `Uso: ${works.uso === '' ? '(sin especificar)' : works.uso}`,
  ];
  // Las notas son texto libre del cliente (pueden imitar un enlace o instrucciones): van como bloque
  // citado, cada línea con `> `, y el enlace REAL va al principio del correo, antes de cualquier dato.
  const quoted = works.notas === '' ? null : works.notas.split(/\r?\n/).map((l) => `> ${l}`);
  const notasHead = quoted === null ? 'Notas del cliente: (sin notas)' : 'Notas del cliente:';
  const lines = stoneLines(quote);
  const reply =
    'Responde en menos de 48 horas; los precios y el flete se capturan en la cotización.';

  const text = [
    ...(link === null ? [] : [`Ver y cotizar en el dashboard: ${link}`, '']),
    head,
    '',
    ...dataLines,
    '',
    'Piedras:',
    ...lines.map((l) => `- ${l}`),
    '',
    notasHead,
    ...(quoted ?? []),
    '',
    reply,
    '',
  ].join('\n');

  const html = wrapHtml(
    [
      ...(link === null
        ? []
        : [`<p><a href="${escapeHtml(link)}">Ver y cotizar en el dashboard</a></p>`]),
      `<p>${escapeHtml(head)}</p>`,
      `<p>${dataLines.map((l) => escapeHtml(l)).join('<br>\n')}</p>`,
      '<p>Piedras:</p>',
      `<ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`,
      `<p>${escapeHtml(notasHead)}</p>`,
      ...(quoted === null
        ? []
        : [
            `<blockquote style="margin:0 0 1em;padding-left:1em;border-left:3px solid #999;color:#444">${toHtml(escapeHtml(works.notas))}</blockquote>`,
          ]),
      `<p>${escapeHtml(reply)}</p>`,
    ].join('\n'),
  );

  return {
    from: fromHeader(pub.nombrePatio, pub.correoRemitente),
    to: pub.correoRemitente,
    subject: oneLine(`Nueva solicitud ${quote.folio}: ${customer.nombre}`),
    text,
    html,
  };
}

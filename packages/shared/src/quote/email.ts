import {
  escapeHtml,
  mailSettingsSchema,
  publicSettingsSchema,
  renderMailTemplate,
  renderMailText,
  type MailSettings,
  type MailTemplateVariable,
  type PublicSettings,
} from '../catalog/settings';
import type { Quote } from './schema';

// Correo de la cotización final (CLAUDE.md 5.2 paso 5, 5.5 y 8). Dominio puro: no envía nada.
// SOLO usa el `finalQuote`, los datos del cliente necesarios y la configuración: jamás notas
// internas, historial, motivo de pérdida ni el estimado automático de flete.

export interface QuoteEmail {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

const money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
const quantity = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 2 });
const longDate = new Intl.DateTimeFormat('es-MX', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'America/Mexico_City',
});
const DAY_MS = 86_400_000;
const UNIT_LABELS: Readonly<Record<string, string>> = {
  m2: 'm²',
  pieza: 'pieza(s)',
  tonelada: 't',
};

/**
 * Una sola línea: los caracteres de control (\p{Cc}, p. ej. U+0085) y de formato (\p{Cf}, p. ej. los
 * de dirección U+202E/U+200F que invierten el texto) y los saltos de línea se vuelven un espacio.
 */
const oneLine = (s: string): string => s.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim();

/** `j***@dominio.com`: para historial, auditoría y logs nunca va el correo completo. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1) return '***';
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

// Un solo destinatario sin separadores ni espacios (defensa en profundidad sobre el esquema).
const RECIPIENT_RE = /^[^\s,;<>"()[\]\\]+@[^\s,;<>"()[\]\\]+$/;

export function isValidRecipient(address: string): boolean {
  return RECIPIENT_RE.test(address);
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 de bytes UTF-8 (sin `btoa`/`Buffer`: shared es isomórfico). */
function base64Utf8(text: string): string {
  const bytes: number[] = [];
  for (const m of encodeURIComponent(text).matchAll(/%([0-9A-F]{2})|([^%])/g)) {
    bytes.push(m[1] !== undefined ? parseInt(m[1], 16) : (m[2] as string).charCodeAt(0));
  }
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b, c] = [bytes[i] as number, bytes[i + 1], bytes[i + 2]];
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? '=' : B64[c & 63];
  }
  return out;
}

const utf8Length = (ch: string): number =>
  encodeURIComponent(ch).replace(/%[0-9A-F]{2}/g, '.').length;

/** Palabras codificadas RFC 2047 de a lo más 45 bytes (72 caracteres), sin partir un carácter. */
function encodedWords(name: string): string {
  const words: string[] = [];
  let chunk = '';
  let bytes = 0;
  for (const ch of name) {
    const n = utf8Length(ch);
    if (bytes + n > 45) {
      words.push(chunk);
      chunk = '';
      bytes = 0;
    }
    chunk += ch;
    bytes += n;
  }
  if (chunk !== '') words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${base64Utf8(w)}?=`).join(' ');
}

/**
 * Encabezado From. Nombre ASCII: entre comillas con `"` y `\` escapados. Con acentos, emoji u otros
 * no ASCII: RFC 2047 (`=?UTF-8?B?...?=`), que es lo que SES y los clientes de correo esperan.
 */
function fromHeader(name: string, address: string): string {
  const clean = oneLine(name);
  if (clean === '') return address;
  if (/^[\x20-\x7e]+$/.test(clean)) {
    return `"${clean.replace(/[\\"]/g, '\\$&')}" <${address}>`;
  }
  return `${encodedWords(clean)} <${address}>`;
}

export function buildQuoteEmail(input: {
  quote: Quote;
  mailSettings: MailSettings;
  publicSettings: PublicSettings;
  /** Momento del envío: de aquí sale la fecha de vencimiento de la vigencia. */
  sentAt: Date;
}): QuoteEmail {
  const { quote, sentAt } = input;
  const mail = mailSettingsSchema.safeParse(input.mailSettings);
  if (!mail.success) throw new Error('La plantilla de correo no es válida.');
  const pub = publicSettingsSchema.safeParse(input.publicSettings);
  if (!pub.success) throw new Error('La configuración del patio no es válida.');

  const fq = quote.finalQuote;
  const priced = fq?.items ?? [];
  if (
    fq === undefined ||
    priced.length !== quote.items.length ||
    !quote.items.every((i) => priced.some((p) => p.stoneId === i.stoneId))
  ) {
    throw new Error('La cotización final está incompleta: falta el precio de alguna piedra.');
  }
  if (!isValidRecipient(quote.customer.correo)) {
    throw new Error('El destinatario no es un correo válido.');
  }

  const lines = quote.items.map((item) => {
    const p = priced.find((x) => x.stoneId === item.stoneId)!;
    const nombre = oneLine(item.acabado === '' ? item.nombre : `${item.nombre} (${item.acabado})`);
    const unit = UNIT_LABELS[item.unidad] ?? item.unidad;
    return `${nombre}: ${quantity.format(item.cantidad)} ${unit} × ${money.format(p.precioUnitario)} = ${money.format(p.subtotal)}`;
  });
  const dias = fq.vigenciaDias;
  const vence = longDate.format(new Date(sentAt.getTime() + dias * DAY_MS));
  const values: Record<MailTemplateVariable, string> = {
    nombre: oneLine(quote.customer.nombre),
    folio: quote.folio,
    piedras: lines.join('\n'),
    flete: `${money.format(fq.fleteFinal)} MXN`,
    total: `${money.format(fq.total)} MXN (sin IVA)`,
    vigencia: `${dias} ${dias === 1 ? 'día' : 'días'}, hasta el ${vence}`,
  };

  const subject = oneLine(renderMailText(mail.data.asuntoCotizacion, values));
  const footer = [
    '',
    'Los importes están en pesos mexicanos (MXN) y no incluyen IVA.',
    '',
    `— ${oneLine(pub.data.nombrePatio)}`,
    `Horario: ${oneLine(pub.data.horario)}`,
    `WhatsApp: https://wa.me/${pub.data.whatsapp}`,
  ].join('\n');
  const text = `${renderMailText(mail.data.plantillaCotizacion, values)}\n${footer}\n`;

  // HTML: se escapa el texto literal de la plantilla y, aparte, cada valor; después solo se
  // insertan <br>. Nada de lo que viene del cliente llega sin escapar.
  const htmlBody = renderMailTemplate(escapeHtml(mail.data.plantillaCotizacion), values);
  const html =
    `<div style="font-family:Arial,sans-serif;line-height:1.5">` +
    `${`${htmlBody}\n${escapeHtml(footer)}`.replace(/\r?\n/g, '<br>\n')}</div>`;

  return {
    from: fromHeader(pub.data.nombrePatio, pub.data.correoRemitente),
    to: quote.customer.correo,
    subject,
    text,
    html,
  };
}

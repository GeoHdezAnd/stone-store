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
import { fromHeader, oneLine } from './mail-headers';
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
  // IVA solo sobre la piedra; el flete va aparte y sin impuesto (total = piedra + IVA + flete).
  const sinIva = fq.iva === null || fq.ivaPct === null;
  const subtotalText = `${money.format(fq.subtotal)} MXN`;
  const ivaText = sinIva ? 'Sin IVA' : `${money.format(fq.iva ?? 0)} MXN (${fq.ivaPct} %)`;
  const totalText = `${money.format(fq.total)} MXN${sinIva ? ' (sin IVA)' : ''}`;
  const values: Record<MailTemplateVariable, string> = {
    nombre: oneLine(quote.customer.nombre),
    folio: quote.folio,
    piedras: lines.join('\n'),
    subtotal: subtotalText,
    iva: ivaText,
    flete: `${money.format(fq.fleteFinal)} MXN`,
    total: totalText,
    vigencia: `${dias} ${dias === 1 ? 'día' : 'días'}, hasta el ${vence}`,
  };

  const subject = oneLine(renderMailText(mail.data.asuntoCotizacion, values));
  // El desglose va SIEMPRE en el pie (no depende de que la plantilla use {{subtotal}} o {{iva}}),
  // para que una plantilla guardada antes de existir el IVA siga mostrando los importes completos.
  const breakdown = sinIva
    ? [
        `Piedra: ${subtotalText}`,
        `Flete: ${money.format(fq.fleteFinal)} MXN`,
        `Total: ${totalText}`,
        '',
        'Precios sin IVA. Los importes están en pesos mexicanos (MXN).',
      ]
    : [
        `Piedra: ${subtotalText}`,
        `IVA (${fq.ivaPct} %): ${money.format(fq.iva ?? 0)} MXN`,
        `Flete (sin IVA): ${money.format(fq.fleteFinal)} MXN`,
        `Total: ${totalText}`,
        '',
        'El IVA se calcula solo sobre la piedra. Los importes están en pesos mexicanos (MXN).',
      ];
  const footer = [
    '',
    'Resumen de importes:',
    ...breakdown,
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

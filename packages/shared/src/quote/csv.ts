import type { Quote } from './schema';

// Exportación CSV de solicitudes (CLAUDE.md 5.3). RFC 4180: todo entre comillas, comillas
// duplicadas, CRLF y BOM UTF-8 (Excel). Neutraliza la inyección de fórmulas (OWASP CSV injection).

export const MAX_EXPORT_ROWS = 5000;

// BOM UTF-8 para que Excel detecte la codificación (carácter escrito con código, no literal).
const BOM = String.fromCharCode(0xfeff);

const HEADERS = [
  'Folio',
  'Fecha',
  'Estado',
  'Nombre',
  'Teléfono',
  'Correo',
  'Código postal',
  'Lugar de la obra',
  'Piedras',
  'Subtotal piedra',
  'IVA %',
  'IVA',
  'Flete final',
  'Total',
  'Motivo de pérdida',
] as const;

// Primer carácter «peligroso» tras ignorar espacios iniciales: = + - @ TAB CR.
const FORMULA_RE = /^ *[=+\-@\t\r]/;

// Teléfono con lada (`+52 222 555 0100`): `+` seguido solo de dígitos, espacios, guiones y paréntesis.
// No se neutraliza (se vería con un apóstrofo en Excel); cualquier otro `+...` sí.
const PHONE_RE = /^ *\+[\d\s()-]*$/;

/** Antepone `'` si Excel/Sheets podrían interpretar la celda como fórmula. */
export function neutralizeFormula(value: string): string {
  if (PHONE_RE.test(value) && !/[\t\r\n]/.test(value)) return value;
  return FORMULA_RE.test(value) ? `'${value}` : value;
}

const cell = (value: string): string => `"${neutralizeFormula(value).replace(/"/g, '""')}"`;
// Los importes son números generados por el sistema (nunca negativos): no pasan por el filtro.
const money = (n: number | undefined): string => (n === undefined ? '""' : `"${n.toFixed(2)}"`);

const pct = (n: number | null | undefined): string =>
  n === null || n === undefined ? '""' : `"${n}"`;

/** Lanza `RangeError` si hay más filas que el tope (quien llama debe recortar a propósito). */
export function quotesToCsv(rows: readonly Quote[]): string {
  if (rows.length > MAX_EXPORT_ROWS) {
    throw new RangeError(`El CSV admite máximo ${MAX_EXPORT_ROWS} filas.`);
  }
  const lines: string[] = [HEADERS.map(cell).join(',')];
  for (const q of rows) {
    lines.push(
      [
        cell(q.folio),
        cell(q.createdAt),
        cell(q.status),
        cell(q.customer.nombre),
        cell(q.customer.telefono),
        cell(q.customer.correo),
        cell(q.works.codigoPostal),
        cell(q.works.lugar),
        cell(q.items.map((i) => i.nombre).join('; ')),
        money(q.finalQuote?.subtotal),
        // Tasa y monto de IVA: vacíos cuando la cotización es sin IVA (`null`).
        pct(q.finalQuote?.ivaPct),
        money(q.finalQuote?.iva ?? undefined),
        money(q.finalQuote?.fleteFinal),
        money(q.finalQuote?.total),
        cell(q.lostReason ?? ''),
      ].join(','),
    );
  }
  return `${BOM}${lines.join('\r\n')}\r\n`;
}

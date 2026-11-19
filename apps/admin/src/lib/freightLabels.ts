const mxn = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
const number = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 2 });

export const formatMxn = (value: number) => mxn.format(value);
export const formatNumber = (value: number) => number.format(value);

export const UNIT_LABELS: Record<string, string> = {
  m2: 'm²',
  pieza: 'Pieza',
  tonelada: 'Tonelada',
};
export const unitLabel = (unit: string) => UNIT_LABELS[unit] ?? unit;

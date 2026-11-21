import { USE_CATEGORY_LABELS, type SoldByUnit, type Stone } from '@canteras/shared';

const SOLD_BY_LABELS: Readonly<Record<SoldByUnit, string>> = {
  m2: 'm²',
  pieza: 'pieza',
  tonelada: 'tonelada',
};

/** «Beige, Crema, Albero». */
export const joinList = (items: readonly string[]): string => items.join(', ');

/** «Fachadas · Muros y sillería». */
export const usesLabel = (stone: Pick<Stone, 'categoriasUso'>): string =>
  stone.categoriasUso.map((c) => USE_CATEGORY_LABELS[c]).join(' · ');

export const soldByLabel = (stone: Pick<Stone, 'vendidaPor'>): string =>
  joinList(stone.vendidaPor.map((u) => SOLD_BY_LABELS[u]));

/** «3, 5 y 8 cm». */
export function thicknessLabel(espesoresCm: readonly number[]): string {
  if (espesoresCm.length === 0) return '—';
  const sorted = [...espesoresCm].sort((a, b) => a - b);
  const last = sorted.pop();
  const head = sorted.length > 0 ? `${sorted.join(', ')} y ` : '';
  return `${head}${last} cm`;
}

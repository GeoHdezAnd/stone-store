import type { SoldByUnit } from '@canteras/shared';

// Enlace `wa.me` con mensaje prellenado (CLAUDE.md 5.1, paso 9). El número va sin «+» ni espacios.

export interface WhatsAppItem {
  nombre: string;
  acabado?: string | undefined;
  cantidad?: number | undefined;
  unidad?: SoldByUnit | undefined;
}

function unitLabel(unidad: SoldByUnit, cantidad: number): string {
  if (unidad === 'm2') return 'm²';
  if (unidad === 'pieza') return cantidad === 1 ? 'pieza' : 'piezas';
  return cantidad === 1 ? 'tonelada' : 'toneladas';
}

function describe(item: WhatsAppItem): string {
  const finish = item.acabado ? ` (${item.acabado})` : '';
  const qty =
    item.cantidad !== undefined && item.unidad !== undefined
      ? ` ${item.cantidad} ${unitLabel(item.unidad, item.cantidad)}`
      : '';
  return `${item.nombre}${finish}${qty}`;
}

export function buildWhatsAppUrl(
  number: string,
  input: { items: readonly WhatsAppItem[]; codigoPostal?: string },
): string {
  const base = `https://wa.me/${number}`;
  const parts: string[] = [];
  if (input.items.length > 0) {
    parts.push(`Hola, quiero cotizar: ${input.items.map(describe).join('; ')}.`);
  } else {
    parts.push('Hola, quiero pedir una cotización.');
  }
  if (input.codigoPostal && /^\d{5}$/.test(input.codigoPostal)) {
    parts.push(`Código postal de la obra: ${input.codigoPostal}.`);
  }
  return `${base}?text=${encodeURIComponent(parts.join(' '))}`;
}

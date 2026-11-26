import type { SoldByUnit, Stone } from '../catalog/stone';
import type { FreightConfig } from './config';
import { FreightError } from './errors';

/** Tope de cantidad por ítem (en su unidad). Evita pesos absurdos y desbordes. */
export const MAX_ITEM_QUANTITY = 100_000;
/** Cantidad mínima por ítem (0.01 de su unidad): evita pesos que redondean a 0. */
export const MIN_ITEM_QUANTITY = 0.01;
/**
 * Tope de peso total por estimado, con merma incluida: 500 t (20 tráileres de 25 t). Más allá
 * no es un estimado automático razonable: se responde `too_large` («consúltenos por WhatsApp»).
 */
export const MAX_TOTAL_WEIGHT_KG = 500_000;
/** Máximo de renglones por estimado. */
export const MAX_ITEMS = 50;

export interface FreightItem {
  stoneId: string;
  cantidad: number;
  unidad: SoldByUnit;
  /** Obligatorio solo para m². */
  espesorCm?: number;
}

/** Redondea a 2 decimales (elimina ruido de coma flotante: 2200 × 0.05 × 210 = 23100.000000000004). */
const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Peso total en kg, con merma incluida, redondeado a 2 decimales.
 *
 * - m²: densidadKgM3 × (espesorCm / 100) × m². El peso por m² sale SOLO de la densidad
 *   (`densidadKgM3`, obligatoria en el esquema de la piedra): es la única fuente de verdad.
 * - pieza: pesoKgPorPieza × n (n entero).
 * - tonelada: n × 1000.
 * - Luego se suma `mermaPct` % (merma/tarima/embalaje).
 *
 * Lanza `FreightError` ante cualquier dato inválido.
 */
export function computeWeightKg(
  items: readonly FreightItem[],
  stones: readonly Stone[],
  config: Pick<FreightConfig, 'mermaPct'>,
): number {
  if (items.length === 0) {
    throw new FreightError('invalid_items', 'Agrega al menos una piedra al estimado.');
  }
  if (items.length > MAX_ITEMS) {
    throw new FreightError('invalid_items', `El estimado admite máximo ${MAX_ITEMS} renglones.`);
  }
  const byId = new Map(stones.map((s) => [s.id, s]));

  let total = 0;
  for (const item of items) {
    const stone = byId.get(item.stoneId);
    if (!stone)
      throw new FreightError('unknown_stone', 'Una de las piedras no existe en el catálogo.');
    if (!stone.activa)
      throw new FreightError('inactive_stone', 'Una de las piedras ya no está disponible.');
    if (!stone.vendidaPor.includes(item.unidad)) {
      throw new FreightError(
        'unit_not_sold',
        'Una de las piedras no se vende en la unidad indicada.',
      );
    }
    const q = item.cantidad;
    if (
      typeof q !== 'number' ||
      !Number.isFinite(q) ||
      q < MIN_ITEM_QUANTITY ||
      q > MAX_ITEM_QUANTITY
    ) {
      throw new FreightError(
        'invalid_quantity',
        `La cantidad debe estar entre ${MIN_ITEM_QUANTITY} y ${MAX_ITEM_QUANTITY}.`,
      );
    }

    switch (item.unidad) {
      case 'm2': {
        const e = item.espesorCm;
        if (e === undefined || !stone.espesoresCm.includes(e)) {
          throw new FreightError(
            'thickness_not_available',
            'El espesor indicado no está disponible para la piedra.',
          );
        }
        total += stone.densidadKgM3 * (e / 100) * q;
        break;
      }
      case 'pieza': {
        if (!Number.isInteger(q)) {
          throw new FreightError('invalid_quantity', 'Las piezas deben ser un número entero.');
        }
        if (stone.pesoKgPorPieza === null) {
          throw new FreightError('unit_not_sold', 'Una de las piedras no se vende por pieza.');
        }
        total += stone.pesoKgPorPieza * q;
        break;
      }
      case 'tonelada':
        total += q * 1000;
        break;
    }
  }
  const kg = round2(total * (1 + config.mermaPct / 100));
  if (kg <= 0) {
    throw new FreightError(
      'invalid_quantity',
      'La cantidad es demasiado pequeña para estimar el peso.',
    );
  }
  if (kg > MAX_TOTAL_WEIGHT_KG) {
    throw new FreightError(
      'too_large',
      'El pedido es demasiado grande para estimarlo en línea: consúltenos por WhatsApp.',
    );
  }
  return kg;
}

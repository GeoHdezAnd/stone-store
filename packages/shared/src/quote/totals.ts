import { toCents } from '../freight/config';
import { IVA_RATES, type IvaPct } from './schema';

// Dinero en MXN con 2 decimales; el cálculo se hace SIEMPRE en centavos enteros (mismo criterio
// que `toCents` del flete). El cliente nunca envía subtotales ni total: los calcula el servidor.

export function mxnFromCents(cents: number): number {
  return cents / 100;
}

export interface TotalsItem {
  stoneId: string;
  cantidad: number;
  unidad: string;
}
export interface TotalsPrice {
  stoneId: string;
  precioUnitario: number;
}
export interface ComputedFinalQuote {
  items: { stoneId: string; precioUnitario: number; subtotal: number }[];
  fleteFinal: number;
  subtotal: number;
  /** IVA de la piedra (el flete no lleva IVA); `null` = sin IVA. */
  iva: number | null;
  ivaPct: IvaPct;
  total: number;
  vigenciaDias: number;
}

/**
 * subtotal por ítem = cantidad × precioUnitario; subtotal = suma de la piedra;
 * iva = round(subtotal × tasa / 100) SOLO sobre la piedra; total = subtotal + iva + fleteFinal.
 * Todo en centavos enteros: subtotal + iva + flete = total siempre, sin ruido de flotantes.
 * Exige exactamente un precio por cada piedra de la solicitud (sin faltantes, sobrantes ni
 * repetidos) y respeta el orden de los renglones de la solicitud.
 */
export function computeFinalQuote(input: {
  items: readonly TotalsItem[];
  prices: readonly TotalsPrice[];
  fleteFinal: number;
  vigenciaDias: number;
  ivaPct: IvaPct;
}): ComputedFinalQuote {
  const { items, prices, fleteFinal, vigenciaDias, ivaPct } = input;
  if (ivaPct !== null && !(IVA_RATES as readonly unknown[]).includes(ivaPct)) {
    throw new Error('La tasa de IVA no es válida.');
  }
  const byStone = new Map<string, number>();
  for (const p of prices) {
    if (byStone.has(p.stoneId)) throw new Error('Precio repetido para una piedra.');
    byStone.set(p.stoneId, p.precioUnitario);
  }
  if (byStone.size !== items.length) throw new Error('Los precios no coinciden con las piedras.');

  let subtotalCents = 0;
  const out = items.map((item) => {
    const precio = byStone.get(item.stoneId);
    if (precio === undefined) throw new Error('Falta el precio de una piedra.');
    const cents = Math.round(item.cantidad * toCents(precio));
    subtotalCents += cents;
    return {
      stoneId: item.stoneId,
      precioUnitario: precio,
      subtotal: mxnFromCents(cents),
    };
  });
  const fleteCents = toCents(fleteFinal);
  // La base del IVA es solo la piedra: el flete va aparte y sin impuesto.
  const ivaCents = ivaPct === null ? null : Math.round((subtotalCents * ivaPct) / 100);
  return {
    items: out,
    fleteFinal: mxnFromCents(fleteCents),
    subtotal: mxnFromCents(subtotalCents),
    iva: ivaCents === null ? null : mxnFromCents(ivaCents),
    ivaPct,
    total: mxnFromCents(subtotalCents + (ivaCents ?? 0) + fleteCents),
    vigenciaDias,
  };
}

import { toCents } from '../freight/config';

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
  /** IVA pendiente de definir (CLAUDE.md 5.5): por ahora siempre `null` = sin IVA. */
  iva: null;
  ivaPct: null;
  total: number;
  vigenciaDias: number;
}

/**
 * subtotal por ítem = cantidad × precioUnitario; subtotal = suma; total = subtotal + fleteFinal.
 * Exige exactamente un precio por cada piedra de la solicitud (sin faltantes, sobrantes ni
 * repetidos) y respeta el orden de los renglones de la solicitud.
 */
export function computeFinalQuote(input: {
  items: readonly TotalsItem[];
  prices: readonly TotalsPrice[];
  fleteFinal: number;
  vigenciaDias: number;
}): ComputedFinalQuote {
  const { items, prices, fleteFinal, vigenciaDias } = input;
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
  return {
    items: out,
    fleteFinal: mxnFromCents(fleteCents),
    subtotal: mxnFromCents(subtotalCents),
    iva: null,
    ivaPct: null,
    total: mxnFromCents(subtotalCents + fleteCents),
    vigenciaDias,
  };
}

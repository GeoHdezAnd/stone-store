import { DEFAULT_VIGENCIA_DIAS, computeFinalQuote, patchBodySchema } from '@canteras/shared';
import type { Quote } from '@canteras/shared';
import { useMemo, useState } from 'react';

/** Borrador de la cotización final: todo como texto, tal cual se escribe. */
export interface FinalDraft {
  prices: Record<string, string>;
  flete: string;
  vigencia: string;
}

export interface FinalQuoteInput {
  items: { stoneId: string; precioUnitario: number }[];
  fleteFinal: number;
  vigenciaDias: number;
}

function initialDraft(quote: Quote): FinalDraft {
  const fq = quote.finalQuote;
  return {
    prices: Object.fromEntries(
      quote.items.map((i) => {
        const price = fq?.items.find((p) => p.stoneId === i.stoneId)?.precioUnitario;
        return [i.stoneId, price === undefined ? '' : String(price)];
      }),
    ),
    flete: fq ? String(fq.fleteFinal) : '',
    vigencia: String(fq?.vigenciaDias ?? DEFAULT_VIGENCIA_DIAS),
  };
}

const toNumber = (text: string): number => (text.trim() === '' ? Number.NaN : Number(text));

/**
 * Estado del borrador de precios. Vive en el contenedor de la solicitud (con `key` por id) para
 * que un conflicto o una recarga NO borren lo que la persona escribió.
 */
export function useFinalQuoteDraft(quote: Quote) {
  const [draft, setDraft] = useState<FinalDraft>(() => initialDraft(quote));

  const input = useMemo<FinalQuoteInput>(
    () => ({
      items: quote.items.map((i) => ({
        stoneId: i.stoneId,
        precioUnitario: toNumber(draft.prices[i.stoneId] ?? ''),
      })),
      fleteFinal: toNumber(draft.flete),
      vigenciaDias: toNumber(draft.vigencia),
    }),
    [quote.items, draft],
  );

  /** Vista previa local (etiquetada «vista previa»): el servidor calcula los totales de verdad. */
  const preview = useMemo(() => {
    const complete =
      input.items.every((p) => Number.isFinite(p.precioUnitario)) &&
      Number.isFinite(input.fleteFinal);
    if (!complete) return null;
    try {
      return computeFinalQuote({
        items: quote.items,
        prices: input.items,
        fleteFinal: input.fleteFinal,
        vigenciaDias: input.vigenciaDias,
      });
    } catch {
      return null;
    }
  }, [input, quote.items]);

  /** Valida con el mismo schema que el servidor; devuelve mensajes en español si algo falla. */
  function validate(): { ok: true; value: FinalQuoteInput } | { ok: false; errors: string[] } {
    const parsed = patchBodySchema.safeParse({ finalQuote: input, rev: 1 });
    if (parsed.success) return { ok: true, value: input };
    return { ok: false, errors: [...new Set(parsed.error.issues.map((i) => i.message))] };
  }

  /** ¿El borrador difiere de lo guardado en el servidor? (hay cambios sin guardar). */
  const dirty = JSON.stringify(draft) !== JSON.stringify(initialDraft(quote));

  /** «Aceptar estimado»: usa el punto medio del rango (el estimado central, sin el margen). */
  function acceptEstimate() {
    const f = quote.freight;
    if (!f) return;
    const mid = Math.round(((f.estimadoMin + f.estimadoMax) / 2) * 100) / 100;
    setDraft((d) => ({ ...d, flete: String(mid) }));
  }

  return { draft, setDraft, preview, dirty, validate, acceptEstimate };
}

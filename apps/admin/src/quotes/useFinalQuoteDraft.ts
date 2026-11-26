import { DEFAULT_VIGENCIA_DIAS, computeFinalQuote, patchBodySchema } from '@canteras/shared';
import type { IvaPct, Quote } from '@canteras/shared';
import { useEffect, useMemo, useState } from 'react';
import { ivaPctToText, parseIvaPct } from '../lib/quoteLabels';

/** Borrador de la cotización final: todo como texto, tal cual se escribe. */
export interface FinalDraft {
  prices: Record<string, string>;
  flete: string;
  vigencia: string;
  /** Tasa de IVA como texto: '' = sin IVA, '8' o '16'. */
  ivaPct: string;
}

export interface FinalQuoteInput {
  items: { stoneId: string; precioUnitario: number }[];
  fleteFinal: number;
  vigenciaDias: number;
  /** Solo la manda el owner; sin ella el servidor conserva la tasa guardada. */
  ivaPct?: IvaPct;
}

/** `ivaPct` explícito: la tasa con la que arranca el selector (por defecto, la guardada). */
function initialDraft(quote: Quote, ivaPct: IvaPct = quote.finalQuote?.ivaPct ?? null): FinalDraft {
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
    ivaPct: ivaPctToText(ivaPct),
  };
}

const toNumber = (text: string): number => (text.trim() === '' ? Number.NaN : Number(text));

/**
 * Estado del borrador de precios. Vive en el contenedor de la solicitud (con `key` por id) para
 * que un conflicto o una recarga NO borren lo que la persona escribió.
 */
export function useFinalQuoteDraft(
  quote: Quote,
  options: { isOwner: boolean; ivaDefault: IvaPct; editable?: boolean } = {
    isOwner: false,
    ivaDefault: null,
  },
) {
  const { isOwner, editable = true } = options;
  const savedIva = quote.finalQuote?.ivaPct ?? null;
  // El valor por defecto de Settings se preselecciona solo para el owner (el staff no puede fijar
  // la tasa: su vista previa debe coincidir con lo que calcula el servidor), en una cotización
  // editable y mientras la tasa guardada sea «sin IVA» (o aún no exista cotización final).
  const presetApplies = isOwner && editable && savedIva === null;
  const [touched, setTouched] = useState(false);
  const [draft, setDraft] = useState<FinalDraft>(() =>
    initialDraft(quote, presetApplies ? options.ivaDefault : savedIva),
  );

  // El valor por defecto llega de forma asíncrona: se aplica mientras el owner no toque el selector.
  const ivaDefault = options.ivaDefault;
  useEffect(() => {
    if (touched || !presetApplies) return;
    setDraft((d) => ({ ...d, ivaPct: ivaPctToText(ivaDefault) }));
  }, [touched, presetApplies, ivaDefault]);

  const setIvaPct = (text: string) => {
    setTouched(true);
    setDraft((d) => ({ ...d, ivaPct: text }));
  };

  /** El selector muestra el valor por defecto de Configuración (no lo eligió ni estaba guardado). */
  const ivaFromDefault = presetApplies && !touched && ivaDefault !== null;

  const input = useMemo<FinalQuoteInput>(
    () => ({
      items: quote.items.map((i) => ({
        stoneId: i.stoneId,
        precioUnitario: toNumber(draft.prices[i.stoneId] ?? ''),
      })),
      fleteFinal: toNumber(draft.flete),
      vigenciaDias: toNumber(draft.vigencia),
      ...(isOwner ? { ivaPct: parseIvaPct(draft.ivaPct) } : {}),
    }),
    [quote.items, draft, isOwner],
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
        // Misma función que el servidor; el staff ve la tasa ya guardada (no la cambia).
        ivaPct: isOwner ? parseIvaPct(draft.ivaPct) : savedIva,
      });
    } catch {
      return null;
    }
  }, [input, quote.items, savedIva, isOwner, draft.ivaPct]);

  /** Valida con el mismo schema que el servidor; devuelve mensajes en español si algo falla. */
  function validate(): { ok: true; value: FinalQuoteInput } | { ok: false; errors: string[] } {
    const parsed = patchBodySchema.safeParse({ finalQuote: input, rev: 1 });
    if (parsed.success) return { ok: true, value: input };
    return { ok: false, errors: [...new Set(parsed.error.issues.map((i) => i.message))] };
  }

  /**
   * ¿El borrador difiere de lo guardado en el servidor? (hay cambios sin guardar). Se compara
   * contra lo GUARDADO: una tasa preseleccionada que difiere cuenta como cambio y hay que guardarla.
   */
  const dirty = JSON.stringify(draft) !== JSON.stringify(initialDraft(quote));

  /** «Aceptar estimado»: usa el punto medio del rango (el estimado central, sin el margen). */
  function acceptEstimate() {
    const f = quote.freight;
    if (!f) return;
    const mid = Math.round(((f.estimadoMin + f.estimadoMax) / 2) * 100) / 100;
    setDraft((d) => ({ ...d, flete: String(mid) }));
  }

  return { draft, setDraft, setIvaPct, ivaFromDefault, preview, dirty, validate, acceptEstimate };
}

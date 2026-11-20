import type { Quote } from '@canteras/shared';
import type { Dispatch, SetStateAction } from 'react';
import { unitLabel } from '../lib/freightLabels';
import { formatMxn } from '../lib/quoteLabels';
import type { FinalDraft } from './useFinalQuoteDraft';

interface FinalQuoteFormProps {
  quote: Quote;
  draft: FinalDraft;
  onDraftChange: Dispatch<SetStateAction<FinalDraft>>;
  /** Vista previa local de totales (null si faltan datos). */
  preview: {
    subtotal: number;
    total: number;
    items: { stoneId: string; subtotal: number }[];
  } | null;
  onAcceptEstimate: () => void;
  canAcceptEstimate: boolean;
  disabled?: boolean;
  /** Errores de validación en español. */
  errors?: readonly string[];
}

/** Captura de precios unitarios, flete y vigencia. Presentación: no llama a la API. */
export function FinalQuoteForm({
  quote,
  draft,
  onDraftChange,
  preview,
  onAcceptEstimate,
  canAcceptEstimate,
  disabled = false,
  errors = [],
}: FinalQuoteFormProps) {
  const setPrice = (stoneId: string, value: string) =>
    onDraftChange((d) => ({ ...d, prices: { ...d.prices, [stoneId]: value } }));
  return (
    <div>
      <div className="price-grid">
        {quote.items.map((item) => (
          <div className="field" key={item.stoneId}>
            <label htmlFor={`price-${item.stoneId}`}>
              Precio unitario de {item.nombre} ({unitLabel(item.unidad)})
            </label>
            <input
              id={`price-${item.stoneId}`}
              className="input"
              inputMode="decimal"
              disabled={disabled}
              value={draft.prices[item.stoneId] ?? ''}
              onChange={(e) => setPrice(item.stoneId, e.target.value)}
            />
            <span className="preview-note">
              {item.cantidad} {unitLabel(item.unidad)} · Subtotal (vista previa):{' '}
              {preview
                ? formatMxn(preview.items.find((i) => i.stoneId === item.stoneId)?.subtotal ?? 0)
                : '—'}
            </span>
          </div>
        ))}
        <div className="field">
          <label htmlFor="final-flete">Flete final (MXN)</label>
          <input
            id="final-flete"
            className="input"
            inputMode="decimal"
            disabled={disabled}
            value={draft.flete}
            onChange={(e) => onDraftChange((d) => ({ ...d, flete: e.target.value }))}
          />
          <button
            type="button"
            className="link-btn"
            disabled={disabled || !canAcceptEstimate}
            onClick={onAcceptEstimate}
          >
            Aceptar estimado
          </button>
          <span className="preview-note">Usa el punto medio del rango estimado.</span>
        </div>
        <div className="field">
          <label htmlFor="final-vigencia">Vigencia (días)</label>
          <input
            id="final-vigencia"
            className="input"
            inputMode="numeric"
            disabled={disabled}
            value={draft.vigencia}
            onChange={(e) => onDraftChange((d) => ({ ...d, vigencia: e.target.value }))}
          />
        </div>
      </div>
      <p className="preview-note" role="status">
        Vista previa — Subtotal: {preview ? formatMxn(preview.subtotal) : '—'} · Total sin IVA:{' '}
        {preview ? formatMxn(preview.total) : '—'}. El total definitivo lo calcula el servidor al
        guardar.
      </p>
      {errors.length > 0 ? (
        <p className="error" role="alert">
          {errors.join(' ')}
        </p>
      ) : null}
    </div>
  );
}

import { QUOTE_STATUSES } from '@canteras/shared';
import type { QuoteStatus } from '@canteras/shared';
import { useId } from 'react';
import { DateRangeFilter } from '../components/DateRangeFilter';
import { SelectField } from '../components/SelectField';
import { MAX_SEARCH_LENGTH, MIN_SEARCH_LENGTH, isSearchable } from '../api/quotesApi';
import { STATUS_LABELS } from '../lib/quoteLabels';

export interface QuoteFilterState {
  status: QuoteStatus | '';
  q: string;
  from: string;
  to: string;
}

/** Filtros de la lista de solicitudes. Controlado por el padre; no toca la URL (hay PII). */
export function QuotesFilters({
  value,
  onChange,
}: {
  value: QuoteFilterState;
  onChange: (next: QuoteFilterState) => void;
}) {
  const searchId = useId();
  const searchHint =
    value.q.trim() !== '' && !isSearchable(value.q)
      ? `Escribe de ${MIN_SEARCH_LENGTH} a ${MAX_SEARCH_LENGTH} caracteres para buscar.`
      : null;
  const set = <K extends keyof QuoteFilterState>(key: K, v: QuoteFilterState[K]) =>
    onChange({ ...value, [key]: v });
  return (
    <div className="filters" role="search">
      <div className="field">
        <label htmlFor={searchId}>Buscar por folio, nombre, teléfono o CP</label>
        <input
          id={searchId}
          className="input"
          type="search"
          autoComplete="off"
          maxLength={MAX_SEARCH_LENGTH}
          aria-describedby={searchHint ? `${searchId}-hint` : undefined}
          value={value.q}
          onChange={(e) => set('q', e.target.value)}
        />
        {searchHint ? (
          <span className="hint" id={`${searchId}-hint`}>
            {searchHint}
          </span>
        ) : null}
      </div>
      <SelectField
        label="Estado"
        value={value.status}
        placeholder="Todos"
        options={QUOTE_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] }))}
        onChange={(v) => set('status', v as QuoteStatus | '')}
      />
      <DateRangeFilter
        from={value.from}
        to={value.to}
        onFromChange={(v) => set('from', v)}
        onToChange={(v) => set('to', v)}
      />
    </div>
  );
}

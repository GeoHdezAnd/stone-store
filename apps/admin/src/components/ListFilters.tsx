import { useId } from 'react';
import type { ActiveFilter } from '../lib/filterRows';

interface ListFiltersProps {
  query: string;
  onQueryChange: (value: string) => void;
  active: ActiveFilter;
  onActiveChange: (value: ActiveFilter) => void;
  labels: { search: string; all: string; active: string; inactive: string; state?: string };
}

/** Búsqueda por texto y filtro por estado. Controlado por el padre. */
export function ListFilters({
  query,
  onQueryChange,
  active,
  onActiveChange,
  labels,
}: ListFiltersProps) {
  const searchId = useId();
  const stateId = useId();
  return (
    <div className="filters" role="search">
      <div className="field">
        <label htmlFor={searchId}>{labels.search}</label>
        <input
          id={searchId}
          className="input"
          type="search"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor={stateId}>{labels.state ?? 'Estado'}</label>
        <select
          id={stateId}
          className="input"
          value={active}
          onChange={(e) => onActiveChange(e.target.value as ActiveFilter)}
        >
          <option value="all">{labels.all}</option>
          <option value="active">{labels.active}</option>
          <option value="inactive">{labels.inactive}</option>
        </select>
      </div>
    </div>
  );
}

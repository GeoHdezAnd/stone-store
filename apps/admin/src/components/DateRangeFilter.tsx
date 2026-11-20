import { useId } from 'react';

interface DateRangeFilterProps {
  from: string;
  to: string;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
  labels?: { from: string; to: string };
}

/** Rango de fechas (`YYYY-MM-DD`). Controlado por el padre. */
export function DateRangeFilter({
  from,
  to,
  onFromChange,
  onToChange,
  labels = { from: 'Desde', to: 'Hasta' },
}: DateRangeFilterProps) {
  const fromId = useId();
  const toId = useId();
  return (
    <>
      <div className="field">
        <label htmlFor={fromId}>{labels.from}</label>
        <input
          id={fromId}
          className="input"
          type="date"
          value={from}
          max={to || undefined}
          onChange={(e) => onFromChange(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor={toId}>{labels.to}</label>
        <input
          id={toId}
          className="input"
          type="date"
          value={to}
          min={from || undefined}
          onChange={(e) => onToChange(e.target.value)}
        />
      </div>
    </>
  );
}

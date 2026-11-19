import type { FormRow, RowFieldDef } from './fieldTypes';

interface RowsFieldProps {
  rows: readonly FormRow[];
  rowFields: readonly RowFieldDef[];
  onChange: (rows: FormRow[]) => void;
  disabled?: boolean;
  /** Nombre de una fila, p. ej. «Camión» (se numera: «Camión 1»). */
  rowLabel: string;
  addLabel: string;
  maxRows?: number | undefined;
  /** Prefijo para los ids de los controles. */
  idPrefix: string;
}

/**
 * Lista dinámica de filas con varias columnas de texto o número. Genérica: no sabe qué
 * representa cada fila ni cómo se valida (eso lo hace el schema del formulario).
 */
export function RowsField({
  rows,
  rowFields,
  onChange,
  disabled = false,
  rowLabel,
  addLabel,
  maxRows,
  idPrefix,
}: RowsFieldProps) {
  const blank = (): FormRow => Object.fromEntries(rowFields.map((rf) => [rf.name, '']));
  const setCell = (index: number, name: string, value: string) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, [name]: value } : row)));
  const atLimit = maxRows !== undefined && rows.length >= maxRows;

  return (
    <div className="rows-field">
      {rows.length === 0 ? <p className="muted">Sin filas.</p> : null}
      {rows.map((row, i) => (
        <fieldset key={i} className="rows-item" disabled={disabled}>
          <legend>
            {rowLabel} {i + 1}
          </legend>
          <div className="rows-grid">
            {rowFields.map((rf) => {
              const id = `${idPrefix}-${i}-${rf.name}`;
              return (
                <div className="field" key={rf.name}>
                  <label htmlFor={id}>{rf.label}</label>
                  <input
                    id={id}
                    className="input"
                    type="text"
                    inputMode={rf.kind === 'number' ? 'decimal' : undefined}
                    value={row[rf.name] ?? ''}
                    onChange={(e) => setCell(i, rf.name, e.target.value)}
                  />
                  {rf.hint ? <span className="hint">{rf.hint}</span> : null}
                </div>
              );
            })}
          </div>
          <button
            type="button"
            className="link-btn"
            aria-label={`Quitar ${rowLabel.toLowerCase()} ${i + 1}`}
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          >
            Quitar
          </button>
        </fieldset>
      ))}
      <button
        type="button"
        className="btn btn-secondary"
        disabled={disabled || atLimit}
        onClick={() => onChange([...rows, blank()])}
      >
        {addLabel}
      </button>
    </div>
  );
}

import type { FieldDef, FormValue } from './fieldTypes';

interface FieldControlProps<T> {
  field: FieldDef<T>;
  id: string;
  value: FormValue;
  onChange: (value: FormValue) => void;
  disabled: boolean;
  invalid: boolean;
  describedBy: string | undefined;
}

/** Control nativo de un campo (texto, número, área, lista, casilla o select). */
export function FieldControl<T>({
  field,
  id,
  value,
  onChange,
  disabled,
  invalid,
  describedBy,
}: FieldControlProps<T>) {
  const common = {
    id,
    disabled,
    'aria-invalid': invalid ? (true as const) : undefined,
    'aria-describedby': describedBy,
  };
  const text = typeof value === 'string' ? value : '';

  switch (field.kind) {
    case 'checkbox':
      return (
        <input
          {...common}
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
      );
    case 'textarea':
    case 'list':
      return (
        <textarea
          {...common}
          className="input"
          rows={field.rows ?? (field.kind === 'list' ? 4 : 5)}
          readOnly={field.readOnly}
          value={text}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'select':
      return (
        <select
          {...common}
          className="input"
          value={text}
          onChange={(e) => onChange(e.target.value)}
        >
          {text === '' ? (
            <option value="" disabled>
              Selecciona…
            </option>
          ) : null}
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    default:
      // Los números y las listas de números conservan el texto tal cual se escribe.
      return (
        <input
          {...common}
          className="input"
          type="text"
          inputMode={
            field.kind === 'number' || field.kind === 'nullable-number' ? 'decimal' : undefined
          }
          readOnly={field.readOnly}
          value={text}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

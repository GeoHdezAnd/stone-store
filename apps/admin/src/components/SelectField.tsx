import { useId } from 'react';

interface SelectFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
  /** Texto de la opción vacía (si se omite, no hay opción vacía). */
  placeholder?: string;
  disabled?: boolean;
  hint?: string;
}

/** Select con etiqueta. Presentación pura, para usar fuera de los formularios dirigidos por campos. */
export function SelectField({
  label,
  value,
  onChange,
  options,
  placeholder,
  disabled = false,
  hint,
}: SelectFieldProps) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        className="input"
        value={value}
        disabled={disabled}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(e) => onChange(e.target.value)}
      >
        {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint ? (
        <span className="hint" id={`${id}-hint`}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

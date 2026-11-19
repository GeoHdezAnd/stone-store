import { useId } from 'react';

interface CheckboxGroupProps {
  options: readonly { value: string; label: string }[];
  value: readonly string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
}

/** Varias casillas para elegir entre opciones fijas. Conserva el orden de `options`. */
export function CheckboxGroup({ options, value, onChange, disabled = false }: CheckboxGroupProps) {
  const baseId = useId();
  function toggle(optionValue: string, checked: boolean) {
    const selected = new Set(value);
    if (checked) selected.add(optionValue);
    else selected.delete(optionValue);
    onChange(options.map((o) => o.value).filter((v) => selected.has(v)));
  }
  return (
    <div className="check-group">
      {options.map((o) => (
        <label key={o.value} className="check-option" htmlFor={`${baseId}-${o.value}`}>
          <input
            id={`${baseId}-${o.value}`}
            type="checkbox"
            checked={value.includes(o.value)}
            disabled={disabled}
            onChange={(e) => toggle(o.value, e.target.checked)}
          />
          {o.label}
        </label>
      ))}
    </div>
  );
}

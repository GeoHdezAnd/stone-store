import { useEffect, useId, useRef } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { FieldErrors } from '../lib/formErrors';

export interface FieldDef<T> {
  name: Extract<keyof T, string>;
  label: string;
  kind: 'text' | 'textarea' | 'checkbox';
  hint?: string;
  readOnly?: boolean;
  disabled?: boolean;
}

interface EntityFormProps<T> {
  fields: readonly FieldDef<T>[];
  values: T;
  errors: FieldErrors;
  onChange: (name: Extract<keyof T, string>, value: string | boolean) => void;
  onSubmit: () => void;
  onCancel: () => void;
  submitLabel: string;
  cancelLabel?: string;
  busy?: boolean;
  /** Error general (no ligado a un campo). */
  formError?: ReactNode;
}

/** Formulario genérico dirigido por campos. No valida ni llama a la API: solo presenta. */
export function EntityForm<T extends Record<string, unknown>>({
  fields,
  values,
  errors,
  onChange,
  onSubmit,
  onCancel,
  submitLabel,
  cancelLabel = 'Cancelar',
  busy = false,
  formError,
}: EntityFormProps<T>) {
  const formRef = useRef<HTMLFormElement>(null);
  const baseId = useId();

  // Tras un intento fallido, el foco va al primer campo inválido.
  useEffect(() => {
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [errors]);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!busy) onSubmit();
  }

  return (
    <form className="form" ref={formRef} onSubmit={submit} noValidate>
      {formError ? (
        <div className="notice notice-error" role="alert">
          {formError}
        </div>
      ) : null}
      {fields.map((field) => {
        const id = `${baseId}-${field.name}`;
        const error = errors[field.name];
        const describedBy =
          [error ? `${id}-error` : null, field.hint ? `${id}-hint` : null]
            .filter(Boolean)
            .join(' ') || undefined;
        const common = {
          id,
          disabled: field.disabled || busy,
          'aria-invalid': error ? (true as const) : undefined,
          'aria-describedby': describedBy,
        };
        const value = values[field.name];
        return (
          <div className="field" key={field.name}>
            <label htmlFor={id}>{field.label}</label>
            {field.kind === 'checkbox' ? (
              <input
                {...common}
                type="checkbox"
                checked={value === true}
                onChange={(e) => onChange(field.name, e.target.checked)}
              />
            ) : field.kind === 'textarea' ? (
              <textarea
                {...common}
                className="input"
                rows={5}
                readOnly={field.readOnly}
                value={typeof value === 'string' ? value : ''}
                onChange={(e) => onChange(field.name, e.target.value)}
              />
            ) : (
              <input
                {...common}
                className="input"
                type="text"
                readOnly={field.readOnly}
                value={typeof value === 'string' ? value : ''}
                onChange={(e) => onChange(field.name, e.target.value)}
              />
            )}
            {field.hint ? (
              <span className="hint" id={`${id}-hint`}>
                {field.hint}
              </span>
            ) : null}
            {error ? (
              <span className="error" id={`${id}-error`}>
                {error}
              </span>
            ) : null}
          </div>
        );
      })}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {submitLabel}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </button>
      </div>
    </form>
  );
}

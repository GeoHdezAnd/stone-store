import { useEffect, useId, useRef } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { FieldErrors } from '../lib/formErrors';
import { CheckboxGroup } from './CheckboxGroup';
import { FieldControl } from './FieldControl';
import type { Draft, FieldDef, FormSection, FormValue } from './fieldTypes';

export type { FieldDef, FormSection } from './fieldTypes';

interface EntityFormProps<T> {
  sections: readonly FormSection<T>[];
  values: Draft;
  /** Alta o edición (lo usan campos `custom`, p. ej. para habilitar subir fotos). */
  mode?: 'create' | 'edit';
  errors: FieldErrors;
  onChange: (name: Extract<keyof T, string>, value: FormValue) => void;
  /** Sin `onSubmit` el formulario queda de solo lectura (sin botones). */
  onSubmit?: (() => void) | undefined;
  onCancel?: (() => void) | undefined;
  submitLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  /** Error general (no ligado a un campo). */
  formError?: ReactNode;
}

/** Formulario genérico dirigido por campos. No valida ni llama a la API: solo presenta. */
export function EntityForm<T>({
  sections,
  values,
  mode = 'edit',
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
    if (!busy) onSubmit?.();
  }

  const renderField = (field: FieldDef<T>) => {
    const id = `${baseId}-${field.name}`;
    const error = errors[field.name];
    const hint = typeof field.hint === 'function' ? field.hint(values) : field.hint;
    const describedBy =
      [error ? `${id}-error` : null, hint ? `${id}-hint` : null].filter(Boolean).join(' ') ||
      undefined;
    const disabled = Boolean(field.disabled) || busy;
    const grouped = field.kind === 'multiselect' || field.kind === 'custom';
    const value = values[field.name] ?? '';
    const set = (v: FormValue) => onChange(field.name, v);
    return (
      <div className={`field ${isFull(field) ? 'field-full' : ''}`} key={field.name}>
        {grouped ? (
          <span className={field.labelHidden ? 'sr-only' : 'field-label'} id={`${id}-label`}>
            {field.label}
          </span>
        ) : (
          <label htmlFor={id} className={field.labelHidden ? 'sr-only' : undefined}>
            {field.label}
          </label>
        )}
        {grouped ? (
          <div
            role="group"
            aria-labelledby={`${id}-label`}
            aria-describedby={describedBy}
            aria-invalid={error ? true : undefined}
            tabIndex={error ? -1 : undefined}
          >
            {field.kind === 'multiselect' ? (
              <CheckboxGroup
                options={field.options ?? []}
                value={Array.isArray(value) ? value : []}
                onChange={set}
                disabled={disabled}
              />
            ) : (
              field.render?.({
                inputId: id,
                name: field.name,
                value,
                onChange: set,
                disabled,
                invalid: Boolean(error),
                describedBy,
                values,
                mode,
              })
            )}
          </div>
        ) : (
          <FieldControl
            field={field}
            id={id}
            value={value}
            onChange={set}
            disabled={disabled}
            invalid={Boolean(error)}
            describedBy={describedBy}
          />
        )}
        {hint ? (
          <span className="hint" id={`${id}-hint`}>
            {hint}
          </span>
        ) : null}
        {error ? (
          <span className="error" id={`${id}-error`}>
            {error}
          </span>
        ) : null}
      </div>
    );
  };

  return (
    <form className="form" ref={formRef} onSubmit={submit} noValidate>
      {formError ? (
        <div className="notice notice-error" role="alert">
          {formError}
        </div>
      ) : null}
      {sections.map((section, i) => {
        const visible = section.fields.filter((f) => !f.visibleWhen || f.visibleWhen(values));
        if (visible.length === 0) return null;
        const headingId = `${baseId}-section-${i}`;
        return (
          <section
            key={section.title ?? i}
            className="form-section"
            aria-labelledby={section.title ? headingId : undefined}
          >
            {section.title ? (
              <h2 className="form-section-title" id={headingId}>
                {section.title}
              </h2>
            ) : null}
            {section.description ? <p className="muted">{section.description}</p> : null}
            <div className="form-grid">{visible.map(renderField)}</div>
          </section>
        );
      })}
      {onSubmit ? (
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {submitLabel ?? 'Guardar'}
          </button>
          {onCancel ? (
            <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>
              {cancelLabel}
            </button>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}

/** Por defecto ocupan todo el ancho los campos largos (áreas, listas, grupos y controles propios). */
function isFull<T>(field: FieldDef<T>): boolean {
  if (field.span) return field.span === 'full';
  return ['textarea', 'list', 'multiselect', 'custom'].includes(field.kind);
}

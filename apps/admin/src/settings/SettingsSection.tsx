import { useId, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { z } from 'zod';
import { ApiError, describeError } from '../api/errors';
import { EntityForm } from '../components/EntityForm';
import { errorAliases, flattenSections, visibleFieldNames } from '../components/fieldTypes';
import type { FormSection } from '../components/fieldTypes';
import { useToastedAction } from '../hooks/useToastedAction';
import { fromDraft, toDraft } from '../lib/draft';
import type { Draft } from '../lib/draft';
import { apiIssuesToFieldErrors, partitionErrors, toFieldErrors } from '../lib/formErrors';
import type { FieldErrors } from '../lib/formErrors';

interface SettingsSectionProps<T> {
  title: string;
  description?: string;
  schema: z.ZodType<T>;
  /** Secciones del formulario (con una sola, sin título, basta). */
  sections: readonly FormSection<never>[];
  /** Valor guardado; `null` si todavía no existe. */
  initial: T | null;
  /** Si es `false` se muestra en solo lectura y sin botón de guardar. */
  canEdit: boolean;
  onSave: (values: T) => Promise<void>;
  successMessage: string;
  /** Contenido extra bajo el formulario (ayudas, vista previa) según el borrador actual. */
  renderExtra?: (draft: Draft) => ReactNode;
  /** Se llama tras guardar bien (p. ej. para refrescar una lista). */
  onSaved?: ((values: T) => void) | undefined;
  /** Se llama si el guardado falla (p. ej. para ofrecer «Recargar» ante un conflicto). */
  onError?: ((err: unknown) => void) | undefined;
}

/** Sección de configuración con su propio borrador, validación y guardado. */
export function SettingsSection<T extends Record<string, unknown>>({
  title,
  description,
  schema,
  sections: formSections,
  initial,
  canEdit,
  onSave,
  successMessage,
  renderExtra,
  onSaved,
  onError,
}: SettingsSectionProps<T>) {
  const headingId = useId();
  const fields = useMemo(() => flattenSections(formSections), [formSections]);
  const aliases = useMemo(() => errorAliases(fields), [fields]);
  const { pending, run } = useToastedAction();
  const [draft, setDraft] = useState<Draft>(() => toDraft(initial, fields));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  // Tras el primer guardado deja de mostrarse el aviso de «sin configuración».
  const [saved, setSaved] = useState(initial !== null);

  const shownFields = useMemo(
    () =>
      formSections.map((section) => ({
        ...section,
        fields: section.fields.map((f) => ({ ...f, disabled: f.disabled || !canEdit })),
      })),
    [formSections, canEdit],
  );

  function showErrors(next: FieldErrors) {
    const { field, general } = partitionErrors(next, visibleFieldNames(fields, draft));
    setErrors(field);
    setFormError(general);
  }

  async function submit() {
    setFormError(null);
    const parsed = schema.safeParse(fromDraft(draft, fields));
    if (!parsed.success) {
      showErrors(toFieldErrors(parsed.error.issues, aliases));
      return;
    }
    setErrors({});
    try {
      await run(() => onSave(parsed.data), { loading: 'Guardando…', success: successMessage });
      setSaved(true);
      onSaved?.(parsed.data);
    } catch (err) {
      onError?.(err);
      if (err instanceof ApiError && err.issues?.length) {
        showErrors(apiIssuesToFieldErrors(err.issues, aliases));
      } else {
        setFormError(describeError(err));
      }
    }
  }

  return (
    <section aria-labelledby={headingId} className="settings-section">
      <h2 id={headingId} className="sec">
        {title}
      </h2>
      {description ? <p className="muted">{description}</p> : null}
      {!saved ? (
        <p className="notice" role="status">
          Todavía no hay configuración guardada.{' '}
          {canEdit ? 'Llena los campos y guarda para crearla.' : 'El dueño debe crearla.'}
        </p>
      ) : null}
      {!canEdit ? <p className="muted">Solo el dueño puede editar esta sección.</p> : null}
      <EntityForm<never>
        sections={shownFields}
        values={draft}
        errors={errors}
        onChange={(name, value) => setDraft((prev) => ({ ...prev, [name]: value }))}
        onSubmit={canEdit ? () => void submit() : undefined}
        submitLabel="Guardar"
        busy={pending}
        formError={formError}
      />
      {renderExtra ? renderExtra(draft) : null}
    </section>
  );
}

import { useMemo, useState } from 'react';
import type { CatalogApi } from '../api/catalogApi';
import { ApiError, describeError } from '../api/errors';
import { EntityForm } from '../components/EntityForm';
import { errorAliases, flattenSections, visibleFieldNames } from '../components/fieldTypes';
import { useIsMounted } from '../hooks/useIsMounted';
import { useToastedAction } from '../hooks/useToastedAction';
import { usePermissions } from '../hooks/usePermissions';
import type { CatalogLabels } from '../lib/catalogLabels';
import { fromDraft, toDraft } from '../lib/draft';
import type { Draft } from '../lib/draft';
import { apiIssuesToFieldErrors, partitionErrors, toFieldErrors } from '../lib/formErrors';
import type { FieldErrors } from '../lib/formErrors';
import type { CatalogConfig, CatalogEntity } from './types';

interface CatalogFormProps<T extends CatalogEntity> {
  config: CatalogConfig<T>;
  api: CatalogApi<T>;
  labels: CatalogLabels;
  /** `null` = alta; con valor = edición de esa entidad. */
  editing: T | null;
  /** Se llama tras guardar bien. El toast ya lo mostró este contenedor. */
  onSaved: (saved: T) => void;
  onCancel: () => void;
}

/** Contenedor: estado del borrador, validación con el schema compartido y guardado. */
export function CatalogForm<T extends CatalogEntity>({
  config,
  api,
  labels,
  editing,
  onSaved,
  onCancel,
}: CatalogFormProps<T>) {
  const { canChangeActive } = usePermissions();
  const base = useMemo<T>(() => editing ?? config.emptyEntity(), [editing, config]);
  const allFields = useMemo(() => flattenSections(config.sections), [config.sections]);
  const aliases = useMemo(() => errorAliases(allFields), [allFields]);
  const [values, setValues] = useState<Draft>(() =>
    toDraft(base, allFields, { blankNumbers: editing === null }),
  );
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const { pending, run } = useToastedAction();
  const isMounted = useIsMounted();

  const sections = useMemo(
    () =>
      config.sections.map((section) => ({
        ...section,
        fields: section.fields.map((f) => ({
          ...f,
          readOnly: f.readOnly || (f.lockedOnEdit === true && editing !== null),
          disabled: f.disabled || (f.ownerOnly === true && !canChangeActive),
        })),
      })),
    [config.sections, editing, canChangeActive],
  );

  /** Pinta cada error junto a su campo visible; el resto va al aviso general. */
  function showErrors(next: FieldErrors) {
    const { field, general } = partitionErrors(next, visibleFieldNames(allFields, values));
    setErrors(field);
    setFormError(general);
  }

  async function submit() {
    setFormError(null);
    const parsed = config.schema.safeParse(fromDraft(values, allFields, base));
    if (!parsed.success) {
      showErrors(toFieldErrors(parsed.error.issues, aliases));
      return;
    }
    setErrors({});
    try {
      await run(() => (editing ? api.update(editing.id, parsed.data) : api.create(parsed.data)), {
        loading: editing ? 'Guardando cambios…' : 'Creando…',
        success: editing ? labels.updated : labels.created,
      });
      // Si la persona ya se fue a otra pantalla, no se navega (el toast de éxito ya salió).
      if (isMounted()) onSaved(parsed.data);
    } catch (err) {
      if (err instanceof ApiError && err.issues?.length) {
        showErrors(apiIssuesToFieldErrors(err.issues, aliases));
      } else if (err instanceof ApiError && err.code === 'invalid_reference' && err.field) {
        showErrors({ [err.field]: describeError(err) });
      } else if (err instanceof ApiError && err.code === 'already_exists') {
        showErrors({ id: describeError(err) });
      } else {
        setFormError(describeError(err));
      }
    }
  }

  return (
    <EntityForm<never>
      sections={sections}
      values={values}
      mode={editing ? 'edit' : 'create'}
      errors={errors}
      onChange={(name, value) => setValues((prev) => ({ ...prev, [name]: value }))}
      onSubmit={() => void submit()}
      onCancel={onCancel}
      cancelLabel="Volver a la lista"
      submitLabel={editing ? 'Guardar cambios' : 'Crear'}
      busy={pending}
      formError={formError}
    />
  );
}

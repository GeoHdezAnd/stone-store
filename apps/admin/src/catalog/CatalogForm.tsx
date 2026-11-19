import { useMemo, useState } from 'react';
import type { CatalogApi } from '../api/catalogApi';
import { ApiError, describeError } from '../api/errors';
import { EntityForm } from '../components/EntityForm';
import { useAsyncAction } from '../hooks/useAsyncAction';
import { usePermissions } from '../hooks/usePermissions';
import type { CatalogLabels } from '../lib/catalogLabels';
import { apiIssuesToFieldErrors, toFieldErrors } from '../lib/formErrors';
import type { FieldErrors } from '../lib/formErrors';
import type { CatalogConfig, CatalogEntity } from './types';

interface CatalogFormProps<T extends CatalogEntity> {
  config: CatalogConfig<T>;
  api: CatalogApi<T>;
  labels: CatalogLabels;
  /** `null` = alta; con valor = edición de esa entidad. */
  editing: T | null;
  onSaved: (message: string) => void;
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
  const [values, setValues] = useState<T>(() => editing ?? config.emptyEntity());
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const { pending, run } = useAsyncAction();

  const fields = useMemo(
    () =>
      config.fields.map((f) => ({
        ...f,
        readOnly: f.readOnly || (f.lockedOnEdit === true && editing !== null),
        disabled: f.disabled || (f.ownerOnly === true && !canChangeActive),
      })),
    [config.fields, editing, canChangeActive],
  );

  async function submit() {
    setFormError(null);
    const parsed = config.schema.safeParse(values);
    if (!parsed.success) {
      setErrors(toFieldErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    try {
      await run(() => (editing ? api.update(editing.id, parsed.data) : api.create(parsed.data)));
      onSaved(editing ? labels.updated : labels.created);
    } catch (err) {
      if (err instanceof ApiError && err.issues?.length) {
        setErrors(apiIssuesToFieldErrors(err.issues));
      } else if (err instanceof ApiError && err.code === 'already_exists') {
        setErrors({ id: describeError(err) });
      } else {
        setFormError(describeError(err));
      }
    }
  }

  return (
    <EntityForm
      fields={fields}
      values={values}
      errors={errors}
      onChange={(name, value) => setValues((prev) => ({ ...prev, [name]: value }))}
      onSubmit={() => void submit()}
      onCancel={onCancel}
      submitLabel={editing ? 'Guardar cambios' : 'Crear'}
      busy={pending}
      formError={formError}
    />
  );
}

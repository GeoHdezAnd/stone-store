import { useCallback, useMemo } from 'react';
import type { FreightApi, FreightVersionSummary } from '../api/freightApi';
import { describeError } from '../api/errors';
import { Notice } from '../components/Notice';
import { SelectField } from '../components/SelectField';
import { useAsyncResource } from '../hooks/useAsyncResource';
import { SettingsSection } from '../settings/SettingsSection';
import { freightFormSchema, freightSections } from './freightForm';
import type { FreightFormValues } from './freightForm';

interface FreightEditorProps {
  api: FreightApi;
  versions: readonly FreightVersionSummary[];
  /** Última versión vista: se manda como `baseVersion` para detectar guardados ajenos (409). */
  latestVersion: string;
  /** Versión que sirve de base del formulario. */
  baseVersion: string;
  onBaseChange: (version: string) => void;
  canEdit: boolean;
  /** Se llama con la versión recién creada. */
  onSaved: (version: string) => void;
  onError: (err: unknown) => void;
}

/** Contenedor del editor: carga la versión base y guarda una versión NUEVA a partir de ella. */
export function FreightEditor({
  api,
  versions,
  latestVersion,
  baseVersion,
  onBaseChange,
  canEdit,
  onSaved,
  onError,
}: FreightEditorProps) {
  const { state, reload } = useAsyncResource(
    useCallback(() => api.get(baseVersion), [api, baseVersion]),
  );
  const options = useMemo(
    () =>
      versions.map((v) => ({
        value: v.version,
        label: `${v.version}${v.activa ? ' (activa)' : ''}${v.ejemplo ? ' · ejemplo' : ''}`,
      })),
    [versions],
  );

  return (
    <>
      <SelectField
        label="Versión base"
        value={baseVersion}
        onChange={onBaseChange}
        options={options}
        hint="Los campos se llenan con esta versión; al guardar se crea una versión nueva."
      />
      {state.status === 'loading' ? (
        <p className="state" role="status">
          Cargando…
        </p>
      ) : state.status === 'error' ? (
        <div className="state">
          <p role="alert">{describeError(state.error)}</p>
          <button type="button" className="btn btn-secondary" onClick={reload}>
            Reintentar
          </button>
        </div>
      ) : (
        <>
          {state.data.ejemplo ? (
            <Notice>Datos de ejemplo: las tarifas de esta versión no son reales.</Notice>
          ) : null}
          <SettingsSection<FreightFormValues>
            key={baseVersion}
            title="Guardar como nueva versión"
            sections={freightSections}
            schema={freightFormSchema}
            initial={
              { ...state.data, resumenCambio: '', activar: false } as unknown as FreightFormValues
            }
            canEdit={canEdit}
            onSave={async (values) => {
              const created = await api.save({ ...values, baseVersion: latestVersion });
              onSaved(created.version);
            }}
            onError={onError}
            successMessage="Versión de tarifas guardada."
          />
        </>
      )}
    </>
  );
}

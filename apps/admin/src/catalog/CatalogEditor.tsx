import { idSchema } from '@canteras/shared';
import { useCallback, useMemo } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, describeError } from '../api/errors';
import { PageHeader } from '../components/PageHeader';
import { useAsyncResource } from '../hooks/useAsyncResource';
import { useCatalogApi } from '../hooks/useCatalogApi';
import { catalogLabels } from '../lib/catalogLabels';
import { CatalogForm } from './CatalogForm';
import type { CatalogConfig, CatalogEntity } from './types';

/**
 * Alta (`/<segment>/new`) o edición (`/<segment>/:id`). El id de la URL es la fuente de verdad:
 * la entidad se carga de la API y un id inválido o inexistente nunca abre el formulario.
 */
export function CatalogEditor<T extends CatalogEntity>({ config }: { config: CatalogConfig<T> }) {
  const { id } = useParams();
  const labels = useMemo(() => catalogLabels(config.noun), [config.noun]);
  const listPath = `/${config.segment}`;

  if (id === undefined) {
    return (
      <>
        <PageHeader title={labels.createTitle} kicker={config.title} />
        <EditorForm key="new" config={config} entity={null} />
      </>
    );
  }
  const validId = idSchema.safeParse(id).success;
  return (
    <>
      <PageHeader title={labels.editTitle} kicker={config.title} />
      {validId ? (
        <LoadedEditor key={`${config.segment}:${id}`} config={config} id={id} />
      ) : (
        <NotFoundState listPath={listPath} title={config.title} />
      )}
    </>
  );
}

function LoadedEditor<T extends CatalogEntity>({
  config,
  id,
}: {
  config: CatalogConfig<T>;
  id: string;
}) {
  const api = useCatalogApi<T>(config.segment);
  const { state, reload } = useAsyncResource(useCallback(() => api.get(id), [api, id]));

  if (state.status === 'loading') {
    return (
      <p className="state" role="status">
        Cargando…
      </p>
    );
  }
  if (state.status === 'error') {
    if (state.error instanceof ApiError && state.error.code === 'not_found') {
      return <NotFoundState listPath={`/${config.segment}`} title={config.title} />;
    }
    return (
      <div className="state">
        <p role="alert">{describeError(state.error)}</p>
        <button type="button" className="btn btn-secondary" onClick={reload}>
          Reintentar
        </button>
      </div>
    );
  }
  return <EditorForm config={config} entity={state.data} />;
}

function EditorForm<T extends CatalogEntity>({
  config,
  entity,
}: {
  config: CatalogConfig<T>;
  entity: T | null;
}) {
  const navigate = useNavigate();
  const api = useCatalogApi<T>(config.segment);
  const labels = useMemo(() => catalogLabels(config.noun), [config.noun]);
  const listPath = `/${config.segment}`;
  return (
    <CatalogForm
      config={config}
      api={api}
      labels={labels}
      editing={entity}
      onCancel={() => navigate(listPath)}
      onSaved={(notice) => navigate(listPath, { state: { notice } })}
    />
  );
}

function NotFoundState({ listPath, title }: { listPath: string; title: string }) {
  return (
    <div className="state">
      <p role="alert">No encontramos este registro. Puede que ya no exista.</p>
      <Link className="btn btn-secondary" to={listPath}>
        Volver a {title.toLowerCase()}
      </Link>
    </div>
  );
}

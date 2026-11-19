import { useCallback, useMemo, useState } from 'react';
import { useApi } from '../api/ApiContext';
import { ApiError, describeError } from '../api/errors';
import { createFreightApi } from '../api/freightApi';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Notice } from '../components/Notice';
import { PageHeader } from '../components/PageHeader';
import { usePagedList } from '../hooks/usePagedList';
import { usePermissions } from '../hooks/usePermissions';
import { useToastedAction } from '../hooks/useToastedAction';
import { FreightEditor } from './FreightEditor';
import { FreightSimulator } from './FreightSimulator';
import { VersionsList } from './VersionsList';

const isConflict = (err: unknown) => err instanceof ApiError && err.code === 'conflict';

/** Flete y tarifas: versiones, editor (nueva versión a partir de una base) y simulador. */
export function FreightScreen() {
  const apiFetch = useApi();
  const api = useMemo(() => createFreightApi(apiFetch), [apiFetch]);
  const list = usePagedList(useCallback((cursor) => api.list(cursor), [api]));
  const { canEditFreight } = usePermissions();
  const { pending, run } = useToastedAction();

  const [baseChoice, setBaseChoice] = useState<string | null>(null);
  const [toActivate, setToActivate] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  const versions = list.items;
  const latestVersion = versions[0]?.version ?? null;
  const activeVersion = versions.find((v) => v.activa)?.version ?? null;
  const baseVersion = baseChoice ?? activeVersion ?? latestVersion;

  async function activate(version: string) {
    setConflict(false);
    try {
      await run(() => api.activate(version), {
        loading: 'Activando…',
        success: (r) =>
          r.changed
            ? `La versión ${version} quedó activa.`
            : `La versión ${version} ya era la activa.`,
        error: (err) =>
          isConflict(err)
            ? 'Otra persona cambió las tarifas antes que tú. Recarga para ver lo último.'
            : describeError(err),
      });
      await list.reload();
    } catch (err) {
      if (isConflict(err)) setConflict(true);
    } finally {
      setToActivate(null);
    }
  }

  return (
    <>
      <PageHeader title="Flete y tarifas" />
      {!canEditFreight ? (
        <p className="muted">Solo el dueño puede editar o activar tarifas.</p>
      ) : null}
      {conflict ? (
        <Notice tone="error">
          Otra persona cambió las tarifas antes que tú.{' '}
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              setConflict(false);
              void list.reload();
            }}
          >
            Recargar
          </button>
        </Notice>
      ) : null}

      <section className="publish-section" aria-labelledby="freight-versions">
        <h2 className="sec" id="freight-versions">
          Versiones de tarifas
        </h2>
        {list.status === 'loading' && versions.length === 0 ? (
          <p className="state" role="status">
            Cargando…
          </p>
        ) : list.status === 'error' ? (
          <div className="state">
            <p role="alert">{describeError(list.error)}</p>
            <button type="button" className="btn btn-secondary" onClick={() => void list.reload()}>
              Reintentar
            </button>
          </div>
        ) : versions.length === 0 ? (
          <p className="state">
            Todavía no hay versiones de tarifas. Se cargan con el seed de ejemplo
            (content/freight-config.json).
          </p>
        ) : (
          <>
            <VersionsList
              versions={versions}
              onUseAsBase={setBaseChoice}
              onActivate={canEditFreight ? setToActivate : undefined}
              disabled={pending}
            />
            {list.error ? <Notice tone="error">{describeError(list.error)}</Notice> : null}
            {list.hasMore ? (
              <p>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={list.loadingMore}
                  onClick={() => void list.loadMore()}
                >
                  {list.loadingMore ? 'Cargando…' : 'Cargar más'}
                </button>
              </p>
            ) : null}
          </>
        )}
      </section>

      {latestVersion && baseVersion ? (
        <section className="publish-section" aria-labelledby="freight-editor">
          <h2 className="sec" id="freight-editor">
            Editor de tarifas
          </h2>
          <FreightEditor
            api={api}
            versions={versions}
            latestVersion={latestVersion}
            baseVersion={baseVersion}
            onBaseChange={setBaseChoice}
            canEdit={canEditFreight}
            onSaved={(version) => {
              setBaseChoice(version);
              void list.reload();
            }}
            onError={(err) => setConflict(isConflict(err))}
          />
        </section>
      ) : null}

      <section className="publish-section" aria-labelledby="freight-simulator">
        <h2 className="sec" id="freight-simulator">
          Simulador de flete
        </h2>
        <FreightSimulator api={api} versions={versions} />
      </section>

      <ConfirmDialog
        open={toActivate !== null}
        title="Activar esta versión"
        confirmLabel="Activar"
        busy={pending}
        onConfirm={() => toActivate && void activate(toActivate)}
        onCancel={() => setToActivate(null)}
      >
        {toActivate
          ? `La versión ${toActivate} será la que se use para calcular el flete. Solo se mueve el puntero de la versión activa: no se borra ninguna versión.`
          : null}
      </ConfirmDialog>
    </>
  );
}

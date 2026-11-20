import { useCallback, useMemo, useState } from 'react';
import { useApi } from '../api/ApiContext';
import { ApiError, describeError } from '../api/errors';
import { createPublishApi } from '../api/publishApi';
import type { PublishResult } from '../api/publishApi';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Notice } from '../components/Notice';
import { PageHeader } from '../components/PageHeader';
import { useAsyncResource } from '../hooks/useAsyncResource';
import { usePermissions } from '../hooks/usePermissions';
import { useToastedAction } from '../hooks/useToastedAction';
import { invalidationNotice } from '../lib/publishLabels';
import { CurrentVersionCard } from './CurrentVersionCard';
import { PendingChanges } from './PendingChanges';
import { PublicationHistory } from './PublicationHistory';

type Confirm = { kind: 'publish' } | { kind: 'revert'; version: string } | null;
/** Acción que originó un `copy_failed`: el reintento debe repetir ESA acción (no crear otra versión). */
type Origin = { kind: 'publish' } | { kind: 'revert'; version: string };
type Problem = { kind: 'conflict' } | { kind: 'copy_failed'; origin: Origin } | null;

/** Publicar: versión vigente, cambios pendientes, publicar e historial con reversión. */
export function PublishScreen() {
  const apiFetch = useApi();
  const api = useMemo(() => createPublishApi(apiFetch), [apiFetch]);
  const { state, reload, refresh } = useAsyncResource(useCallback(() => api.list(), [api]));
  const { canPublish } = usePermissions();
  const { pending, run } = useToastedAction();

  const [confirm, setConfirm] = useState<Confirm>(null);
  const [problem, setProblem] = useState<Problem>(null);
  const [outcome, setOutcome] = useState<ReturnType<typeof invalidationNotice>>(null);

  /** Ejecuta publicar/revertir con toast, muestra el resultado y refresca sin salir de la página. */
  async function execute(
    origin: Origin,
    action: () => Promise<PublishResult>,
    messages: {
      loading: string;
      changed: (r: PublishResult & { changed: true }) => string;
      unchanged: string;
    },
  ) {
    setProblem(null);
    setOutcome(null);
    try {
      const result = await run(action, {
        loading: messages.loading,
        success: (r) => (r.changed ? messages.changed(r) : messages.unchanged),
        error: (err) =>
          err instanceof ApiError && err.code === 'conflict'
            ? 'Otra persona publicó antes que tú. Recarga para ver lo último.'
            : describeError(err),
      });
      setOutcome(invalidationNotice(result.invalidation));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'conflict') setProblem({ kind: 'conflict' });
      else if (err instanceof ApiError && err.code === 'copy_failed')
        setProblem({ kind: 'copy_failed', origin });
    } finally {
      setConfirm(null);
      await refresh();
    }
  }

  const publish = () =>
    execute({ kind: 'publish' }, () => api.publish(), {
      loading: 'Publicando…',
      changed: (r) => `Versión ${r.version} publicada.`,
      unchanged: 'Sin cambios: el sitio ya está al día.',
    });

  const revert = (version: string) =>
    execute({ kind: 'revert', version }, () => api.revert(version), {
      loading: 'Revirtiendo…',
      changed: (r) => `Se publicó ${r.version} con el contenido de ${version}.`,
      unchanged: 'Sin cambios: el sitio ya tiene ese contenido.',
    });

  const data = state.status === 'ready' ? state.data : null;
  const pendingCount = data ? data.pending.items.length : 0;

  return (
    <>
      <PageHeader
        title="Publicar"
        actions={
          canPublish ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={pending || data === null}
              onClick={() => setConfirm({ kind: 'publish' })}
            >
              Publicar
            </button>
          ) : (
            <p className="muted">Solo el dueño puede publicar.</p>
          )
        }
      />

      {problem?.kind === 'conflict' ? (
        <Notice tone="error">
          Otra persona publicó antes que tú, así que esta publicación no se guardó.{' '}
          <button type="button" className="link-btn" onClick={() => void refresh()}>
            Recargar
          </button>
        </Notice>
      ) : null}
      {problem?.kind === 'copy_failed' ? (
        <Notice tone="error">
          La versión se guardó, pero no se pudo actualizar la copia vigente del sitio.{' '}
          {canPublish ? (
            <button
              type="button"
              className="link-btn"
              onClick={() =>
                void (problem.origin.kind === 'revert' ? revert(problem.origin.version) : publish())
              }
            >
              Reintentar
            </button>
          ) : null}
        </Notice>
      ) : null}
      {outcome ? <Notice tone={outcome.tone}>{outcome.text}</Notice> : null}

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
          <section className="publish-section" aria-labelledby="publish-current">
            <h2 className="sec" id="publish-current">
              Versión publicada
            </h2>
            <CurrentVersionCard current={state.data.current} />
          </section>

          <section className="publish-section" aria-labelledby="publish-pending">
            <h2 className="sec" id="publish-pending">
              Cambios pendientes desde la última publicación ({pendingCount}
              {state.data.pending.truncated ? '+' : ''})
            </h2>
            <PendingChanges
              items={state.data.pending.items}
              truncated={state.data.pending.truncated}
            />
          </section>

          <section className="publish-section" aria-labelledby="publish-history">
            <h2 className="sec" id="publish-history">
              Historial de versiones
            </h2>
            <PublicationHistory
              publications={state.data.publications}
              currentVersion={state.data.current?.version ?? null}
              onRevert={
                canPublish ? (version) => setConfirm({ kind: 'revert', version }) : undefined
              }
              disabled={pending}
            />
          </section>
        </>
      )}

      <ConfirmDialog
        open={confirm?.kind === 'publish'}
        title="Publicar el catálogo"
        confirmLabel="Publicar"
        busy={pending}
        onConfirm={() => void publish()}
        onCancel={() => setConfirm(null)}
      >
        {pendingCount === 0
          ? 'No hay cambios pendientes. Si el sitio ya está al día, no se creará una versión nueva.'
          : `Se publicarán ${pendingCount}${data?.pending.truncated ? ' o más' : ''} cambio(s) y el sitio público mostrará el catálogo actualizado.`}
      </ConfirmDialog>

      <ConfirmDialog
        open={confirm?.kind === 'revert'}
        title="Revertir a esta versión"
        confirmLabel="Revertir"
        busy={pending}
        onConfirm={() => confirm?.kind === 'revert' && void revert(confirm.version)}
        onCancel={() => setConfirm(null)}
      >
        {confirm?.kind === 'revert'
          ? `Se creará una publicación nueva con el contenido de ${confirm.version}. No se borra ninguna versión: el historial se conserva.`
          : null}
      </ConfirmDialog>
    </>
  );
}

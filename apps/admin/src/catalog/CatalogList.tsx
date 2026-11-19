import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { describeError } from '../api/errors';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { DataTable } from '../components/DataTable';
import type { Column } from '../components/DataTable';
import { ListFilters } from '../components/ListFilters';
import { Notice } from '../components/Notice';
import { PageHeader } from '../components/PageHeader';
import { StatusTag } from '../components/StatusTag';
import { useCatalogApi } from '../hooks/useCatalogApi';
import { useAsyncAction } from '../hooks/useAsyncAction';
import { usePagedList } from '../hooks/usePagedList';
import { usePermissions } from '../hooks/usePermissions';
import { catalogLabels } from '../lib/catalogLabels';
import { filterRows } from '../lib/filterRows';
import type { ActiveFilter } from '../lib/filterRows';
import type { CatalogConfig, CatalogEntity } from './types';

type ResultNotice = { tone: 'info' | 'error'; text: string } | null;

/**
 * Lista genérica de un catálogo con baja/reactivación. Alta y edición viven en rutas propias
 * (`/<segment>/new`, `/<segment>/:id`); aquí solo se enlaza a ellas. Cada entidad aporta su config.
 */
export function CatalogList<T extends CatalogEntity>({ config }: { config: CatalogConfig<T> }) {
  const labels = useMemo(() => catalogLabels(config.noun), [config.noun]);
  const api = useCatalogApi<T>(config.segment);
  const location = useLocation();
  const navigate = useNavigate();
  const list = usePagedList<T>(useCallback((cursor) => api.list(cursor), [api]));
  const { canDeactivate } = usePermissions();
  const { pending, run } = useAsyncAction();

  // Aviso que dejó el editor al volver (se guarda en el historial de navegación).
  const [notice, setNotice] = useState<ResultNotice>(() => noticeFromState(location.state));
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<ActiveFilter>('all');
  const [toDeactivate, setToDeactivate] = useState<T | null>(null);

  // Consume el aviso del historial para que F5 o «Atrás» no lo repitan.
  useEffect(() => {
    if (location.state) navigate(location.pathname, { replace: true, state: null });
    // Solo al montar.
  }, []);

  const rows = useMemo(
    () => filterRows(list.items, query, active, config.searchText),
    [list.items, query, active, config],
  );

  const columns = useMemo<Column<T>[]>(
    () => [
      ...config.columns,
      {
        key: '_estado',
        header: 'Estado',
        render: (row) => (
          <StatusTag
            active={row.activa}
            activeLabel={labels.active}
            inactiveLabel={labels.inactive}
          />
        ),
      },
    ],
    [config.columns, labels],
  );

  async function mutate(action: () => Promise<void>, success: string) {
    setNotice(null);
    try {
      await run(action);
      setNotice({ tone: 'info', text: success });
      await list.reload();
    } catch (err) {
      setNotice({ tone: 'error', text: describeError(err) });
    }
  }

  async function confirmDeactivate() {
    if (!toDeactivate) return;
    const row = toDeactivate;
    await mutate(() => api.remove(row.id), labels.deactivated);
    setToDeactivate(null);
  }

  function reactivate(row: T) {
    void mutate(() => api.update(row.id, { ...row, activa: true }), labels.reactivated);
  }

  return (
    <>
      <PageHeader
        title={config.title}
        actions={
          <Link className="btn btn-primary" to={`/${config.segment}/new`}>
            {labels.newButton}
          </Link>
        }
      />
      {notice ? (
        <Notice tone={notice.tone} onDismiss={() => setNotice(null)}>
          {notice.text}
        </Notice>
      ) : null}

      {list.status === 'loading' ? (
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
      ) : list.items.length === 0 && !list.hasMore ? (
        <p className="state">{labels.empty}</p>
      ) : (
        <>
          <ListFilters
            query={query}
            onQueryChange={setQuery}
            active={active}
            onActiveChange={setActive}
            labels={{
              search: labels.searchLabel,
              all: labels.filterAll,
              active: labels.filterActive,
              inactive: labels.filterInactive,
            }}
          />
          {list.error ? <Notice tone="error">{describeError(list.error)}</Notice> : null}
          {rows.length === 0 ? (
            <p className="state">{labels.noMatches}</p>
          ) : (
            <DataTable
              caption={config.title}
              columns={columns}
              rows={rows}
              getRowKey={(row) => row.id}
              renderActions={(row) => (
                <span className="row-actions">
                  <Link
                    className="link-btn"
                    to={`/${config.segment}/${encodeURIComponent(row.id)}`}
                    aria-label={`Editar ${config.rowName(row)}`}
                  >
                    Editar
                  </Link>
                  {canDeactivate && row.activa ? (
                    <button
                      type="button"
                      className="link-btn"
                      aria-label={`Dar de baja ${config.rowName(row)}`}
                      onClick={() => setToDeactivate(row)}
                    >
                      Dar de baja
                    </button>
                  ) : null}
                  {canDeactivate && !row.activa ? (
                    <button
                      type="button"
                      className="link-btn"
                      aria-label={`Reactivar ${config.rowName(row)}`}
                      disabled={pending}
                      onClick={() => reactivate(row)}
                    >
                      Reactivar
                    </button>
                  ) : null}
                </span>
              )}
            />
          )}
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

      <ConfirmDialog
        open={toDeactivate !== null}
        title={labels.deactivateTitle}
        confirmLabel="Dar de baja"
        busy={pending}
        onConfirm={() => void confirmDeactivate()}
        onCancel={() => setToDeactivate(null)}
      >
        {toDeactivate ? labels.deactivateBody(config.rowName(toDeactivate)) : null}
      </ConfirmDialog>
    </>
  );
}

function noticeFromState(state: unknown): ResultNotice {
  const text = (state as { notice?: unknown } | null)?.notice;
  return typeof text === 'string' ? { tone: 'info', text } : null;
}

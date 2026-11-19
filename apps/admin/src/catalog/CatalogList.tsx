import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { describeError } from '../api/errors';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { DataTable } from '../components/DataTable';
import type { Column } from '../components/DataTable';
import { ListFilters } from '../components/ListFilters';
import { Notice } from '../components/Notice';
import { PageHeader } from '../components/PageHeader';
import { StatusTag } from '../components/StatusTag';
import { useCatalogApi } from '../hooks/useCatalogApi';
import { useToastedAction } from '../hooks/useToastedAction';
import { usePagedList } from '../hooks/usePagedList';
import { usePermissions } from '../hooks/usePermissions';
import { catalogLabels } from '../lib/catalogLabels';
import { filterRows } from '../lib/filterRows';
import type { ActiveFilter } from '../lib/filterRows';
import type { CatalogConfig, CatalogEntity } from './types';

/**
 * Lista genérica de un catálogo con baja/reactivación. Alta y edición viven en rutas propias
 * (`/<segment>/new`, `/<segment>/:id`); aquí solo se enlaza a ellas. Cada entidad aporta su config.
 */
export function CatalogList<T extends CatalogEntity>({ config }: { config: CatalogConfig<T> }) {
  const labels = useMemo(() => catalogLabels(config.noun), [config.noun]);
  const api = useCatalogApi<T>(config.segment);
  const list = usePagedList<T>(useCallback((cursor) => api.list(cursor), [api]));
  const { canDeactivate } = usePermissions();
  const { pending, run } = useToastedAction();

  const [query, setQuery] = useState('');
  const [active, setActive] = useState<ActiveFilter>('all');
  const [toDeactivate, setToDeactivate] = useState<T | null>(null);

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

  async function mutate(
    action: () => Promise<void>,
    messages: { loading: string; success: string },
  ) {
    try {
      await run(action, messages); // el toast informa el resultado (también el error)
      await list.reload();
    } catch {
      /* el error ya se mostró en el toast */
    }
  }

  async function confirmDeactivate() {
    if (!toDeactivate) return;
    const row = toDeactivate;
    await mutate(() => api.remove(row.id), {
      loading: 'Dando de baja…',
      success: labels.deactivated,
    });
    setToDeactivate(null);
  }

  function reactivate(row: T) {
    // Se relee el registro: la fila de la lista puede estar desactualizada y pisaría otra edición.
    void mutate(
      async () => {
        const fresh = await api.get(row.id);
        await api.update(row.id, { ...fresh, activa: true });
      },
      {
        loading: 'Reactivando…',
        success: labels.reactivated,
      },
    );
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

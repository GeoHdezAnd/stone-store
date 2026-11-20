import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { describeError } from '../api/errors';
import { isSearchable } from '../api/quotesApi';
import type { QuoteFilters, QuoteSummary } from '../api/quotesApi';
import { DataTable } from '../components/DataTable';
import type { Column } from '../components/DataTable';
import { Notice } from '../components/Notice';
import { PageHeader } from '../components/PageHeader';
import { Tag } from '../components/Tag';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { usePagedList } from '../hooks/usePagedList';
import { usePermissions } from '../hooks/usePermissions';
import { useQuotesApi } from '../hooks/useQuotesApi';
import { useToastedAction } from '../hooks/useToastedAction';
import {
  STATUS_TONES,
  ageLabel,
  formatDateTime,
  formatMxn,
  isOverdue,
  statusLabel,
} from '../lib/quoteLabels';
import { saveBlob } from '../lib/saveBlob';
import { QuotesFilters } from './QuotesFilters';
import type { QuoteFilterState } from './QuotesFilters';

const EMPTY_FILTERS: QuoteFilterState = { status: '', q: '', from: '', to: '' };

function summarizeStones(names: readonly string[]): string {
  if (names.length <= 2) return names.join(', ');
  return `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
}

const columns: readonly Column<QuoteSummary>[] = [
  {
    key: 'folio',
    header: 'Folio',
    render: (q) => (
      <Link className="link-btn" to={`/quotes/${q.quoteId}`}>
        {q.folio}
      </Link>
    ),
  },
  { key: 'fecha', header: 'Fecha', render: (q) => formatDateTime(q.createdAt) },
  { key: 'cliente', header: 'Cliente', render: (q) => q.customer.nombre },
  {
    key: 'estado',
    header: 'Estado',
    render: (q) => (
      <span className="row-actions">
        <Tag tone={STATUS_TONES[q.status]}>{statusLabel(q.status)}</Tag>
        {isOverdue(q.status, q.createdAt) ? (
          <Tag tone="accent">Más de 48 h sin responder</Tag>
        ) : null}
      </span>
    ),
  },
  { key: 'piedras', header: 'Piedras', render: (q) => summarizeStones(q.piedras) },
  {
    key: 'total',
    header: 'Total',
    numeric: true,
    render: (q) => (q.total === null ? '—' : formatMxn(q.total)),
  },
  { key: 'edad', header: 'Antigüedad', render: (q) => ageLabel(q.createdAt) },
];

/** Lista de solicitudes con filtros (solo en estado de React), «Cargar más» y exportación CSV. */
export function QuotesListScreen() {
  const api = useQuotesApi();
  const { canExportQuotes } = usePermissions();
  const { pending, run } = useToastedAction();
  const [filters, setFilters] = useState<QuoteFilterState>(EMPTY_FILTERS);
  const [exportNotice, setExportNotice] = useState<string | null>(null);

  // La búsqueda espera a que se deje de escribir; el resto de filtros aplica de inmediato.
  const q = useDebouncedValue(filters.q);
  const applied = useMemo<QuoteFilters>(
    () => ({
      ...(filters.status ? { status: filters.status } : {}),
      ...(q && isSearchable(q) ? { q } : {}),
      ...(filters.from ? { from: filters.from } : {}),
      ...(filters.to ? { to: filters.to } : {}),
    }),
    [filters.status, filters.from, filters.to, q],
  );
  const list = usePagedList(useCallback((cursor) => api.list(applied, cursor), [api, applied]));

  // Con `q` la API puede devolver páginas vacías con cursor: se sigue cargando.
  const { status, items, hasMore, loadingMore, loadMore, error } = list;
  useEffect(() => {
    if (status === 'ready' && items.length === 0 && hasMore && !loadingMore && !error) {
      void loadMore();
    }
  }, [status, items.length, hasMore, loadingMore, loadMore, error]);

  async function exportCsv() {
    setExportNotice(null);
    try {
      const result = await run(() => api.exportCsv(applied), {
        loading: 'Exportando…',
        success: 'CSV descargado.',
      });
      saveBlob(result.blob, `solicitudes-${new Date().toISOString().slice(0, 10)}.csv`);
      const warnings: string[] = [];
      if (result.truncated)
        warnings.push('El archivo se recortó: hay más solicitudes que las exportadas.');
      if (result.skipped > 0)
        warnings.push(`${result.skipped} solicitud(es) no se pudieron exportar.`);
      setExportNotice(warnings.length > 0 ? warnings.join(' ') : null);
    } catch {
      /* el toast ya informó el error */
    }
  }

  return (
    <>
      <PageHeader
        title="Solicitudes"
        actions={
          canExportQuotes ? (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={pending}
              onClick={() => void exportCsv()}
            >
              Exportar CSV
            </button>
          ) : undefined
        }
      />
      {exportNotice ? (
        <Notice onDismiss={() => setExportNotice(null)}>{exportNotice}</Notice>
      ) : null}
      <QuotesFilters value={filters} onChange={setFilters} />

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
        <p className="state">No hay solicitudes con estos filtros.</p>
      ) : (
        <>
          {list.error ? <Notice tone="error">{describeError(list.error)}</Notice> : null}
          <DataTable
            caption="Solicitudes de cotización"
            columns={columns}
            rows={list.items}
            getRowKey={(q2) => q2.quoteId}
          />
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
    </>
  );
}

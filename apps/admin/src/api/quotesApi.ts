import { normalizeSearchQuery } from '@canteras/shared';
import type { LostReason, PatchBody, Quote, QuoteStatus } from '@canteras/shared';
import type { Page } from './catalogApi';
import type { ApiDownload, ApiFetch } from './client';

export interface QuoteSummary {
  quoteId: string;
  folio: string;
  createdAt: string;
  status: QuoteStatus;
  customer: { nombre: string; telefono: string; correo: string };
  works: { lugar: string; codigoPostal: string };
  piedras: string[];
  estimadoMin: number | null;
  estimadoMax: number | null;
  total: number | null;
  rev: number;
  ejemplo?: boolean;
}

/** Filtros de la lista. Viven solo en estado de React: nunca en la URL de la página (hay PII). */
export interface QuoteFilters {
  status?: QuoteStatus;
  /** Búsqueda por folio, nombre, teléfono o CP (la API pide 2 a 60 caracteres). */
  q?: string;
  /** Fechas `YYYY-MM-DD`. */
  from?: string;
  to?: string;
}

export const MIN_SEARCH_LENGTH = 2;
export const MAX_SEARCH_LENGTH = 60;

/** ¿La búsqueda cumple lo que pide el servidor (2 a 60 caracteres ya normalizada)? */
export function isSearchable(q: string): boolean {
  const n = normalizeSearchQuery(q.trim());
  return n.length >= MIN_SEARCH_LENGTH && n.length <= MAX_SEARCH_LENGTH;
}

/** Cuerpo de `PATCH`: lo que se puede cambiar, más `rev`. */
export type QuotePatch = Omit<PatchBody, 'rev'> & { lostReason?: LostReason };

export interface CsvExport {
  blob: Blob;
  truncated: boolean;
  skipped: number;
}

export interface QuotesApi {
  list(filters: QuoteFilters, cursor: string | null): Promise<Page<QuoteSummary>>;
  get(quoteId: string): Promise<Quote>;
  patch(quoteId: string, rev: number, patch: QuotePatch): Promise<Quote>;
  addNote(quoteId: string, rev: number, texto: string): Promise<Quote>;
  /** Solo `owner`. */
  send(quoteId: string, rev: number): Promise<Quote>;
  /** Solo `owner`. Respeta los filtros; el `q` va en el query de la petición, no en la URL de la página. */
  exportCsv(filters: QuoteFilters): Promise<CsvExport>;
}

const PAGE_SIZE = 25;

function filterParams(filters: QuoteFilters): URLSearchParams {
  const query = new URLSearchParams();
  if (filters.status) query.set('status', filters.status);
  const q = filters.q?.trim();
  if (q && isSearchable(q)) query.set('q', q);
  if (filters.from) query.set('from', filters.from);
  if (filters.to) query.set('to', filters.to);
  return query;
}

/** Único lugar que conoce las rutas de solicitudes. */
export function createQuotesApi(api: ApiFetch, download: ApiDownload): QuotesApi {
  const item = (id: string) => `/admin/quotes/${encodeURIComponent(id)}`;
  return {
    list: (filters, cursor) => {
      const query = filterParams(filters);
      query.set('limit', String(PAGE_SIZE));
      if (cursor) query.set('cursor', cursor);
      return api<Page<QuoteSummary>>(`/admin/quotes?${query.toString()}`);
    },
    get: (id) => api<Quote>(item(id)),
    patch: (id, rev, patch) => api<Quote>(item(id), { method: 'PATCH', body: { ...patch, rev } }),
    addNote: (id, rev, texto) =>
      api<Quote>(`${item(id)}/notes`, { method: 'POST', body: { texto, rev } }),
    send: (id, rev) => api<Quote>(`${item(id)}/send`, { method: 'POST', body: { rev } }),
    exportCsv: async (filters) => {
      const query = filterParams(filters).toString();
      const { blob, headers } = await download(
        `/admin/quotes/export.csv${query ? `?${query}` : ''}`,
        {
          accept: 'text/csv',
        },
      );
      return {
        blob,
        truncated: headers.get('x-export-truncated') === 'true',
        skipped: Number(headers.get('x-export-skipped') ?? 0) || 0,
      };
    },
  };
}

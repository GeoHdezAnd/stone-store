import type { ApiFetch } from './client';

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Operaciones HTTP de un recurso CRUD del catálogo. Único lugar que conoce estas rutas. */
export interface CatalogApi<T> {
  list(cursor: string | null): Promise<Page<T>>;
  get(id: string): Promise<T>;
  create(entity: T): Promise<void>;
  update(id: string, entity: T): Promise<void>;
  /** Baja lógica (solo `owner`: la API responde 403 a `staff`). */
  remove(id: string): Promise<void>;
}

const PAGE_SIZE = 50;

export function createCatalogApi<T>(api: ApiFetch, segment: string): CatalogApi<T> {
  const base = `/admin/${segment}`;
  const item = (id: string) => `${base}/${encodeURIComponent(id)}`;
  return {
    list: (cursor) => {
      const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (cursor) query.set('cursor', cursor);
      return api<Page<T>>(`${base}?${query.toString()}`);
    },
    get: (id) => api<T>(item(id)),
    create: async (entity) => {
      await api(base, { method: 'POST', body: entity });
    },
    update: async (id, entity) => {
      await api(item(id), { method: 'PUT', body: entity });
    },
    remove: async (id) => {
      await api(item(id), { method: 'DELETE' });
    },
  };
}

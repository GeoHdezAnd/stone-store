import { useMemo } from 'react';
import { useApi } from '../api/ApiContext';
import { createCatalogApi } from '../api/catalogApi';
import type { CatalogApi } from '../api/catalogApi';

/** Cliente de un recurso del catálogo ligado a la sesión. */
export function useCatalogApi<T>(segment: string): CatalogApi<T> {
  const apiFetch = useApi();
  return useMemo(() => createCatalogApi<T>(apiFetch, segment), [apiFetch, segment]);
}

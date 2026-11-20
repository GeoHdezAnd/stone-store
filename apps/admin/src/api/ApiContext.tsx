import { createContext, useContext } from 'react';
import type { ApiDownload, ApiFetch } from './client';

export const ApiContext = createContext<ApiFetch | null>(null);

/** Cliente de la API ya ligado a la sesión (lo usan las pantallas de 2.7.2). */
export function useApi(): ApiFetch {
  const api = useContext(ApiContext);
  if (!api) throw new Error('useApi debe usarse dentro de <App>.');
  return api;
}

export const ApiDownloadContext = createContext<ApiDownload | null>(null);

/** Descargas de archivos ya ligadas a la sesión. */
export function useApiDownload(): ApiDownload {
  const download = useContext(ApiDownloadContext);
  if (!download) throw new Error('useApiDownload debe usarse dentro de <App>.');
  return download;
}

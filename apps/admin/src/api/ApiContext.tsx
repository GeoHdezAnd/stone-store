import { createContext, useContext } from 'react';
import type { ApiFetch } from './client';

export const ApiContext = createContext<ApiFetch | null>(null);

/** Cliente de la API ya ligado a la sesión (lo usan las pantallas de 2.7.2). */
export function useApi(): ApiFetch {
  const api = useContext(ApiContext);
  if (!api) throw new Error('useApi debe usarse dentro de <App>.');
  return api;
}

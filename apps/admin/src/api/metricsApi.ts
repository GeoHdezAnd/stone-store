import { metricsResponseSchema, type MetricsResponse } from '@canteras/shared';
import type { ApiFetch } from './client';
import { UserMessageError } from './errors';

export interface MetricsApi {
  /** Resumen del dashboard (solo lectura). */
  get(): Promise<MetricsResponse>;
}

/** Único lugar que conoce la ruta del resumen. Valida la respuesta con el esquema compartido. */
export function createMetricsApi(api: ApiFetch): MetricsApi {
  return {
    get: async () => {
      const raw = await api<unknown>('/admin/metrics');
      const parsed = metricsResponseSchema.safeParse(raw);
      if (!parsed.success) {
        throw new UserMessageError(
          'La respuesta del resumen no tiene el formato esperado. Recarga la página; si sigue igual, avisa a soporte.',
        );
      }
      return parsed.data;
    },
  };
}

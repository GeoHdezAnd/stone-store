import { FREIGHT_VERSION_PATTERN } from '@canteras/shared';
import type { FreightConfig, FreightEstimate } from '@canteras/shared';
import type { Page } from './catalogApi';
import type { ApiFetch } from './client';

export interface FreightVersionSummary {
  version: string;
  activa: boolean;
  ejemplo?: boolean;
  creadaPor: string | null;
  creadaAt: string | null;
  resumenCambio: string;
}

export type FreightConfigDetail = FreightConfig & { activa: boolean };

export interface SimulateItem {
  stoneId: string;
  cantidad: number;
  unidad: 'm2' | 'pieza' | 'tonelada';
  espesorCm?: number;
}

export interface SimulateRequest {
  codigoPostal?: string;
  distanciaKm: number;
  items: SimulateItem[];
  /** Si falta, se usa la tarifa activa. */
  version?: string;
  skipZoneCheck?: boolean;
}

export interface FreightApi {
  /** Versiones, de la más reciente a la más antigua. */
  list(cursor: string | null): Promise<Page<FreightVersionSummary>>;
  get(version: string): Promise<FreightConfigDetail>;
  /** Solo `owner`. Crea una versión NUEVA; `baseVersion` = la última versión vista. */
  save(body: Record<string, unknown>): Promise<FreightConfigDetail>;
  /** Solo `owner`. Mueve el puntero de la versión activa (no borra nada). */
  activate(version: string): Promise<{ changed: boolean; version: string }>;
  simulate(request: SimulateRequest): Promise<FreightEstimate>;
}

const PAGE_SIZE = 20;

function assertVersion(version: string): void {
  if (!FREIGHT_VERSION_PATTERN.test(version)) throw new TypeError('Versión de tarifas no válida.');
}

/** Único lugar que conoce las rutas de flete. */
export function createFreightApi(api: ApiFetch): FreightApi {
  return {
    list: async (cursor) => {
      const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (cursor) query.set('cursor', cursor);
      const res = await api<{ versions: FreightVersionSummary[]; nextCursor: string | null }>(
        `/admin/freight-config?${query.toString()}`,
      );
      return { items: res.versions, nextCursor: res.nextCursor };
    },
    get: (version) => {
      assertVersion(version);
      return api<FreightConfigDetail>(`/admin/freight-config/${version}`);
    },
    save: (body) => api<FreightConfigDetail>('/admin/freight-config', { method: 'PUT', body }),
    activate: (version) => {
      assertVersion(version);
      return api(`/admin/freight-config/${version}/activate`, { method: 'POST' });
    },
    simulate: (request) => {
      if (request.version !== undefined) assertVersion(request.version);
      return api<FreightEstimate>('/admin/freight/simulate', { method: 'POST', body: request });
    },
  };
}

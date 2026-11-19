import { CATALOG_VERSION_PATTERN } from '@canteras/shared';
import type { ApiFetch } from './client';

export interface PublicationCounts {
  stones: number;
  finishes: number;
  projects: number;
  services: number;
}

export type PublicationAction = 'publish' | 'revert';

/** Resultado de la invalidación de caché de CloudFront. */
export type InvalidationStatus = 'ok' | 'skipped' | 'failed';

export interface CurrentPublication {
  version: string;
  action: PublicationAction;
  publishedAt: string;
  publishedBy: string;
}

export interface PublicationItem extends CurrentPublication {
  counts: PublicationCounts;
  /** Solo en reversiones: versión cuyo contenido se republicó. */
  revertedFrom?: string;
}

export interface PendingChange {
  entity: string;
  id: string;
  at: string;
  accion: string;
  userId: string;
}

export interface PublicationsSnapshot {
  current: CurrentPublication | null;
  publications: PublicationItem[];
  pending: { items: PendingChange[]; truncated: boolean };
}

export type PublishResult =
  | {
      changed: true;
      version: string;
      publishedAt: string;
      counts: PublicationCounts;
      invalidation: InvalidationStatus;
      revertedFrom?: string;
    }
  | { changed: false; version: string; invalidation: InvalidationStatus };

export interface PublishApi {
  list(): Promise<PublicationsSnapshot>;
  /** Solo `owner`. */
  publish(): Promise<PublishResult>;
  /** Solo `owner`. Crea una versión NUEVA con el contenido de `version`. */
  revert(version: string): Promise<PublishResult>;
}

/** Único lugar que conoce las rutas de publicación. */
export function createPublishApi(api: ApiFetch): PublishApi {
  return {
    list: () => api<PublicationsSnapshot>('/admin/publications'),
    publish: () => api<PublishResult>('/admin/publish', { method: 'POST' }),
    revert: (version) => {
      if (!CATALOG_VERSION_PATTERN.test(version)) {
        return Promise.reject(new TypeError('Versión de catálogo no válida.'));
      }
      return api<PublishResult>(`/admin/publications/${version}/revert`, { method: 'POST' });
    },
  };
}

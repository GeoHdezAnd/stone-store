import type { InvalidationStatus, PublicationAction } from '../api/publishApi';

const ENTITY_LABELS: Record<string, string> = {
  stone: 'Piedra',
  finish: 'Acabado',
  project: 'Proyecto',
  service: 'Servicio',
  settings: 'Configuración',
};

const CHANGE_LABELS: Record<string, string> = {
  create: 'Alta',
  update: 'Edición',
  delete: 'Baja',
};

export const entityLabel = (entity: string) => ENTITY_LABELS[entity] ?? entity;
export const changeLabel = (accion: string) => CHANGE_LABELS[accion] ?? accion;

export function publicationLabel(action: PublicationAction, revertedFrom?: string): string {
  return action === 'revert'
    ? `Reversión a ${revertedFrom ?? 'una versión anterior'}`
    : 'Publicación';
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
}

/** Identificador opaco de la persona, abreviado (nunca correo ni nombre). */
export function shortUser(userId: string): string {
  return userId.length > 8 ? `${userId.slice(0, 8)}…` : userId;
}

/** Aviso en lenguaje claro según la invalidación de caché; `null` si todo salió bien. */
export function invalidationNotice(
  status: InvalidationStatus,
): { tone: 'info' | 'error'; text: string } | null {
  if (status === 'skipped') {
    return {
      tone: 'info',
      text: 'La invalidación de CloudFront aún no está configurada: el sitio puede tardar en mostrar el cambio.',
    };
  }
  if (status === 'failed') {
    return {
      tone: 'error',
      text: 'La versión se publicó, pero no se pudo invalidar la caché de CloudFront. El sitio puede tardar en mostrar el cambio; vuelve a publicar para reintentar.',
    };
  }
  return null;
}

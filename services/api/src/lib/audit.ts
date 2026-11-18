export const AUDIT_ACTIONS = [
  'create',
  'update',
  'delete',
  'publish',
  'revert',
  'send',
  'status',
  'invite',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEntry {
  pk: string;
  sk: string;
  userId: string;
  accion: string;
  antes: unknown;
  despues: unknown;
}

export interface AuditInput {
  entityType: string;
  entityId: string;
  userId: string;
  action: string;
  before: unknown;
  after: unknown;
  at: Date;
  requestId: string;
}

// DynamoDB limita un ítem a 400 KB; dejamos margen.
const MAX_ITEM_BYTES = 300 * 1024;
const ENTITY_TYPE_RE = /^[a-z][a-z0-9-]{0,31}$/;
// Ids: slugs, ULID (mayúsculas) o versiones; sin `#`, `/` ni espacios.
const ENTITY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._=-]{0,127}$/;

/**
 * Arma el ítem de la tabla AuditLog (función pura, sin I/O).
 *
 * `sk = "<ISO>#<requestId>"` es una pequeña extensión de «sk = ISO timestamp»
 * (CLAUDE.md 6.2): sigue ordenándose por tiempo, pero evita que dos escrituras
 * en el mismo milisegundo se sobrescriban entre sí.
 */
export function buildAuditEntry(input: AuditInput): AuditEntry {
  const { entityType, entityId, userId, action, before, after, at, requestId } = input;
  if (!ENTITY_TYPE_RE.test(entityType)) throw new Error('Auditoría: entityType inválido.');
  if (!ENTITY_ID_RE.test(entityId)) throw new Error('Auditoría: entityId inválido.');
  if (typeof userId !== 'string' || userId.trim() === '')
    throw new Error('Auditoría: userId vacío.');
  if (!(AUDIT_ACTIONS as readonly string[]).includes(action)) {
    throw new Error('Auditoría: acción no permitida.');
  }
  if (!REQUEST_ID_RE.test(requestId)) throw new Error('Auditoría: requestId inválido.');
  if (!(at instanceof Date) || Number.isNaN(at.getTime()))
    throw new Error('Auditoría: fecha inválida.');

  const entry: AuditEntry = {
    pk: `ENTITY#${entityType}#${entityId}`,
    sk: `${at.toISOString()}#${requestId}`,
    userId,
    accion: action,
    antes: before ?? null,
    despues: after ?? null,
  };
  const bytes = Buffer.byteLength(JSON.stringify(entry), 'utf8');
  if (bytes > MAX_ITEM_BYTES) {
    throw new Error(
      `Auditoría: el ítem pesa ${Math.ceil(bytes / 1024)} KB y excede el máximo de ${MAX_ITEM_BYTES / 1024} KB.`,
    );
  }
  return entry;
}

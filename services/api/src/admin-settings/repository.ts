import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { SETTINGS_ROW_KEYS } from '@canteras/shared';
import type { AuditEntry } from '../lib/audit';

/** Valor de la clave de partición de las filas únicas (`PUBLIC`, `MAIL` y `QUOTING`). */
export type SettingsRowKey = (typeof SETTINGS_ROW_KEYS)[keyof typeof SETTINGS_ROW_KEYS];

/** Transacción cancelada por un conflicto con otra en curso (`TransactionConflict`): reintentable. */
export class ConflictError extends Error {
  constructor() {
    super('Conflicto con otra transacción en curso.');
    this.name = 'ConflictError';
  }
}

/**
 * Acceso a datos de la configuración. Son tres filas únicas; no hay borrado ni listado.
 * `put` es un UPSERT ATÓMICO: la fila y su auditoría se guardan juntas o no se guarda ninguna.
 */
export interface SettingsRepository {
  /** Fila tal como está guardada (con su atributo `key`); `null` si no existe. */
  get(key: SettingsRowKey): Promise<Record<string, unknown> | null>;
  put(key: SettingsRowKey, data: Record<string, unknown>, audit: AuditEntry): Promise<void>;
}

/** Lo mínimo que se usa de `DynamoDBDocumentClient` (se inyecta para poder probar sin AWS). */
export interface DocClient {
  send(command: unknown): Promise<unknown>;
}

const AUDIT_CONDITION = 'attribute_not_exists(pk) AND attribute_not_exists(sk)';

export class DynamoSettingsRepository implements SettingsRepository {
  constructor(
    private readonly client: DocClient,
    private readonly settingsTable: string,
    private readonly auditTable: string,
  ) {}

  async get(key: SettingsRowKey): Promise<Record<string, unknown> | null> {
    const out = (await this.client.send(
      new GetCommand({ TableName: this.settingsTable, Key: { key }, ConsistentRead: true }),
    )) as { Item?: Record<string, unknown> };
    return out.Item ?? null;
  }

  /**
   * Índice 0 = la fila (sin condición: UPSERT), índice 1 = la auditoría. Solo un
   * `TransactionConflict` es de dominio (409); cualquier otro motivo, incluido un
   * `ConditionalCheckFailed` de la auditoría duplicada, se propaga como error interno.
   */
  async put(key: SettingsRowKey, data: Record<string, unknown>, audit: AuditEntry): Promise<void> {
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            // `key` va al final: los datos nunca pueden cambiar a qué fila se escribe.
            { Put: { TableName: this.settingsTable, Item: { ...data, key } } },
            {
              Put: {
                TableName: this.auditTable,
                Item: audit,
                ConditionExpression: AUDIT_CONDITION,
              },
            },
          ],
        }),
      );
    } catch (err) {
      if (isTransactionConflict(err)) throw new ConflictError();
      throw err;
    }
  }
}

function isTransactionConflict(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: unknown; CancellationReasons?: unknown };
  if (e.name !== 'TransactionCanceledException' || !Array.isArray(e.CancellationReasons)) {
    return false;
  }
  return (e.CancellationReasons as { Code?: string }[]).some(
    (r) => r.Code === 'TransactionConflict',
  );
}

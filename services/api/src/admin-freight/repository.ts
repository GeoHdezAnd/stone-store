import { BatchGetCommand, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { AuditEntry } from '../lib/audit';

/** Clave de la fila puntero de la tabla FreightConfig (no cumple `FREIGHT_VERSION_PATTERN`). */
export const ACTIVE_KEY = 'ACTIVE';

/**
 * Fila puntero `ACTIVE`. Guarda la versión activa y la ÚLTIMA versión creada: de ahí sale el
 * siguiente número (`latestVersion + 1`) sin Scan ni contador aparte, y la condición de la
 * transacción lo usa como control de concurrencia optimista.
 */
export interface PointerRow {
  version: typeof ACTIVE_KEY;
  activeVersion: string;
  latestVersion: string;
  activadaPor: string;
  activadaAt: string;
}

/** Fila de una versión (`t0001`...): INMUTABLE, sin `activa` (se deriva del puntero). */
export type VersionRow = Record<string, unknown>;

/** Otra persona guardó o activó antes (condición fallida) o hay una transacción en conflicto. */
export class ConflictError extends Error {
  constructor() {
    super('Conflicto con otro cambio de tarifas en curso.');
    this.name = 'ConflictError';
  }
}

export interface CreateVersionInput {
  /** Puntero leído antes de decidir (`null` = aún no hay versiones). */
  basePointer: PointerRow | null;
  row: VersionRow & { version: string };
  /** Puntero resultante (misma activa, o la nueva si se activa). */
  pointer: PointerRow;
  audit: AuditEntry;
}

export interface SetActiveInput {
  basePointer: PointerRow;
  pointer: PointerRow;
  audit: AuditEntry;
}

/**
 * Acceso a datos de las tarifas. Las dos escrituras son ATÓMICAS:
 * - `createVersion`: fila nueva (solo si no existe) + puntero (solo si sigue igual al leído) +
 *   auditoría.
 * - `setActive`: puntero (solo si sigue igual al leído) + auditoría.
 * Las lecturas son consistentes (ConsistentRead).
 */
export interface FreightRepository {
  getPointer(): Promise<PointerRow | null>;
  getVersion(version: string): Promise<VersionRow | null>;
  /** Las filas de las versiones pedidas que existan, de la más nueva a la más vieja. */
  getVersions(versions: readonly string[]): Promise<VersionRow[]>;
  /** Piedras por id (las que no existan simplemente no vienen). */
  getStones(ids: readonly string[]): Promise<Record<string, unknown>[]>;
  createVersion(input: CreateVersionInput): Promise<void>;
  setActive(input: SetActiveInput): Promise<void>;
}

/** Lo mínimo que se usa de `DynamoDBDocumentClient` (se inyecta para poder probar sin AWS). */
export interface DocClient {
  send(command: unknown): Promise<unknown>;
}

export interface FreightTables {
  freightConfig: string;
  stones: string;
  auditLog: string;
}

export interface DynamoFreightOptions {
  sleep?: (ms: number) => Promise<void>;
}

const AUDIT_CONDITION = 'attribute_not_exists(pk) AND attribute_not_exists(sk)';
const MAX_BATCH_ATTEMPTS = 5;
// BatchGetItem admite 100 claves por llamada.
const BATCH_SIZE = 100;

/** Condición del puntero: no existe aún, o sigue exactamente como se leyó. */
function pointerCondition(base: PointerRow | null) {
  return base === null
    ? {
        ConditionExpression: 'attribute_not_exists(#v)',
        ExpressionAttributeNames: { '#v': 'version' },
      }
    : {
        ConditionExpression: '#al = :latest AND #ac = :active',
        ExpressionAttributeNames: { '#al': 'latestVersion', '#ac': 'activeVersion' },
        ExpressionAttributeValues: { ':latest': base.latestVersion, ':active': base.activeVersion },
      };
}

export class DynamoFreightRepository implements FreightRepository {
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly client: DocClient,
    private readonly tables: FreightTables,
    options: DynamoFreightOptions = {},
  ) {
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async getPointer(): Promise<PointerRow | null> {
    const out = (await this.client.send(
      new GetCommand({
        TableName: this.tables.freightConfig,
        Key: { version: ACTIVE_KEY },
        ConsistentRead: true,
      }),
    )) as { Item?: PointerRow };
    return out.Item ?? null;
  }

  async getVersion(version: string): Promise<VersionRow | null> {
    const out = (await this.client.send(
      new GetCommand({
        TableName: this.tables.freightConfig,
        Key: { version },
        ConsistentRead: true,
      }),
    )) as { Item?: VersionRow };
    return out.Item ?? null;
  }

  private async batchGet(
    table: string,
    keyName: string,
    ids: readonly string[],
  ): Promise<Record<string, unknown>[]> {
    const unique = [...new Set(ids)];
    const found: Record<string, unknown>[] = [];
    for (let i = 0; i < unique.length; i += BATCH_SIZE) {
      let keys: Record<string, unknown>[] = unique
        .slice(i, i + BATCH_SIZE)
        .map((id) => ({ [keyName]: id }));
      for (let attempt = 0; keys.length > 0; attempt++) {
        if (attempt >= MAX_BATCH_ATTEMPTS) {
          throw new Error('BatchGetItem no resolvió todas las UnprocessedKeys.');
        }
        if (attempt > 0) await this.sleep(Math.min(50 * 2 ** attempt, 1000));
        const out = (await this.client.send(
          new BatchGetCommand({ RequestItems: { [table]: { Keys: keys, ConsistentRead: true } } }),
        )) as {
          Responses?: Record<string, Record<string, unknown>[]>;
          UnprocessedKeys?: Record<string, { Keys?: Record<string, unknown>[] }>;
        };
        found.push(...(out.Responses?.[table] ?? []));
        keys = out.UnprocessedKeys?.[table]?.Keys ?? [];
      }
    }
    return found;
  }

  async getVersions(versions: readonly string[]): Promise<VersionRow[]> {
    const rows = await this.batchGet(this.tables.freightConfig, 'version', versions);
    return rows.sort((a, b) => {
      const x = String(a['version']);
      const y = String(b['version']);
      return x < y ? 1 : x > y ? -1 : 0;
    });
  }

  getStones(ids: readonly string[]): Promise<Record<string, unknown>[]> {
    return this.batchGet(this.tables.stones, 'id', ids);
  }

  async createVersion(input: CreateVersionInput): Promise<void> {
    const { basePointer, row, pointer, audit } = input;
    await this.transact(
      [
        {
          Put: {
            TableName: this.tables.freightConfig,
            Item: row,
            ConditionExpression: 'attribute_not_exists(#v)',
            ExpressionAttributeNames: { '#v': 'version' },
          },
        },
        {
          Put: {
            TableName: this.tables.freightConfig,
            Item: pointer,
            ...pointerCondition(basePointer),
          },
        },
        {
          Put: {
            TableName: this.tables.auditLog,
            Item: audit,
            ConditionExpression: AUDIT_CONDITION,
          },
        },
      ],
      2,
    );
  }

  async setActive(input: SetActiveInput): Promise<void> {
    const { basePointer, pointer, audit } = input;
    await this.transact(
      [
        {
          Put: {
            TableName: this.tables.freightConfig,
            Item: pointer,
            ...pointerCondition(basePointer),
          },
        },
        {
          Put: {
            TableName: this.tables.auditLog,
            Item: audit,
            ConditionExpression: AUDIT_CONDITION,
          },
        },
      ],
      1,
    );
  }

  /** `domainItems`: cuántos ítems iniciales son de dominio (el resto es la auditoría). */
  private async transact(items: unknown[], domainItems: number): Promise<void> {
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: items as never }));
    } catch (err) {
      if (isConflict(err, domainItems)) throw new ConflictError();
      throw err;
    }
  }
}

/**
 * Conflicto de dominio: falló la condición de la fila de versión o del puntero (los primeros
 * `domainItems` ítems) o hay una transacción en curso. Un fallo de la auditoría NO lo es.
 */
function isConflict(err: unknown, domainItems: number): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: unknown; CancellationReasons?: unknown };
  if (e.name !== 'TransactionCanceledException' || !Array.isArray(e.CancellationReasons)) {
    return false;
  }
  const reasons = e.CancellationReasons as { Code?: string }[];
  return reasons.some(
    (r, i) =>
      r.Code === 'TransactionConflict' || (i < domainItems && r.Code === 'ConditionalCheckFailed'),
  );
}

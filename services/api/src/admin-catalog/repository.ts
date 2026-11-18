import {
  BatchGetCommand,
  GetCommand,
  ScanCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import type { AuditEntry } from '../lib/audit';

export type EntityName = 'stone' | 'project' | 'finish' | 'service';

/** Entidad del catálogo ya validada: todas tienen `id` y baja lógica `activa`. */
export type CatalogItem = { id: string; activa: boolean } & Record<string, unknown>;

export interface ListParams {
  limit: number;
  /** Ya validada por quien llama (ver cursor.ts). */
  exclusiveStartKey?: { id: string };
}

export interface ListPage {
  /** Items tal como están guardados: quien llama decide qué hacer con los inválidos. */
  items: Record<string, unknown>[];
  /** Clave del último item evaluado; `null` si no hay más páginas. */
  lastKey: { id: string } | null;
}

/** La entidad ya existe (falló `attribute_not_exists(id)`). */
export class AlreadyExistsError extends Error {
  constructor() {
    super('La entidad ya existe.');
    this.name = 'AlreadyExistsError';
  }
}

/** La entidad no existe (falló `attribute_exists(id)`). */
export class NotFoundError extends Error {
  constructor() {
    super('La entidad no existe.');
    this.name = 'NotFoundError';
  }
}

/** Transacción cancelada por un conflicto con otra en curso (`TransactionConflict`): reintentable. */
export class ConflictError extends Error {
  constructor() {
    super('Conflicto con otra transacción en curso.');
    this.name = 'ConflictError';
  }
}

/**
 * Acceso a datos del catálogo. Cada escritura recibe la entrada de auditoría ya armada y es
 * ATÓMICA: la entidad y su auditoría se guardan juntas o no se guarda ninguna.
 * No existe un borrado físico: la baja es lógica (`softDelete`).
 */
export interface CatalogRepository {
  get(entity: EntityName, id: string): Promise<Record<string, unknown> | null>;
  list(entity: EntityName, params: ListParams): Promise<ListPage>;
  /** Devuelve los ids que NO existen (vacío = todos existen). */
  existsAll(entity: EntityName, ids: readonly string[]): Promise<string[]>;
  create(entity: EntityName, item: CatalogItem, audit: AuditEntry): Promise<void>;
  replace(entity: EntityName, item: CatalogItem, audit: AuditEntry): Promise<void>;
  softDelete(entity: EntityName, id: string, audit: AuditEntry): Promise<void>;
}

/** Lo mínimo que se usa de `DynamoDBDocumentClient` (se inyecta para poder probar sin AWS). */
export interface DocClient {
  send(command: unknown): Promise<unknown>;
}

export interface DynamoRepositoryOptions {
  /** Espera entre reintentos de `UnprocessedKeys`; inyectable para pruebas. */
  sleep?: (ms: number) => Promise<void>;
}

const BATCH_SIZE = 100; // tope de BatchGetItem
const MAX_BATCH_ATTEMPTS = 6;
const AUDIT_CONDITION = 'attribute_not_exists(pk) AND attribute_not_exists(sk)';

interface CancellationReason {
  Code?: string;
}

type Operation = 'create' | 'replace' | 'softDelete';

export class DynamoCatalogRepository implements CatalogRepository {
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly client: DocClient,
    private readonly tables: Readonly<Record<EntityName, string>>,
    private readonly auditTable: string,
    options: DynamoRepositoryOptions = {},
  ) {
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async get(entity: EntityName, id: string): Promise<Record<string, unknown> | null> {
    const out = (await this.client.send(
      new GetCommand({ TableName: this.tables[entity], Key: { id }, ConsistentRead: true }),
    )) as { Item?: Record<string, unknown> };
    return out.Item ?? null;
  }

  async list(entity: EntityName, params: ListParams): Promise<ListPage> {
    const out = (await this.client.send(
      new ScanCommand({
        TableName: this.tables[entity],
        Limit: params.limit,
        ConsistentRead: true,
        ...(params.exclusiveStartKey
          ? { ExclusiveStartKey: { id: params.exclusiveStartKey.id } }
          : {}),
      }),
    )) as { Items?: Record<string, unknown>[]; LastEvaluatedKey?: Record<string, unknown> };
    const last = out.LastEvaluatedKey;
    if (last === undefined) return { items: out.Items ?? [], lastKey: null };
    if (typeof last['id'] !== 'string') {
      throw new Error('DynamoDB devolvió un LastEvaluatedKey inesperado.');
    }
    return { items: out.Items ?? [], lastKey: { id: last['id'] } };
  }

  async existsAll(entity: EntityName, ids: readonly string[]): Promise<string[]> {
    const unique = [...new Set(ids)];
    const found = new Set<string>();
    const table = this.tables[entity];
    for (let i = 0; i < unique.length; i += BATCH_SIZE) {
      let keys: Record<string, unknown>[] = unique.slice(i, i + BATCH_SIZE).map((id) => ({ id }));
      for (let attempt = 0; keys.length > 0; attempt++) {
        if (attempt >= MAX_BATCH_ATTEMPTS) {
          throw new Error(
            'BatchGetItem no resolvió todas las UnprocessedKeys tras varios reintentos.',
          );
        }
        if (attempt > 0) await this.sleep(Math.min(50 * 2 ** attempt, 1000));
        const out = (await this.client.send(
          new BatchGetCommand({
            RequestItems: {
              [table]: {
                Keys: keys,
                ProjectionExpression: '#id',
                ExpressionAttributeNames: { '#id': 'id' },
                ConsistentRead: true,
              },
            },
          }),
        )) as {
          Responses?: Record<string, Record<string, unknown>[]>;
          UnprocessedKeys?: Record<string, { Keys?: Record<string, unknown>[] }>;
        };
        for (const row of out.Responses?.[table] ?? []) {
          if (typeof row['id'] === 'string') found.add(row['id']);
        }
        keys = out.UnprocessedKeys?.[table]?.Keys ?? [];
      }
    }
    return unique.filter((id) => !found.has(id));
  }

  async create(entity: EntityName, item: CatalogItem, audit: AuditEntry): Promise<void> {
    await this.transact('create', [
      {
        Put: {
          TableName: this.tables[entity],
          Item: item,
          ConditionExpression: 'attribute_not_exists(id)',
        },
      },
      this.auditPut(audit),
    ]);
  }

  async replace(entity: EntityName, item: CatalogItem, audit: AuditEntry): Promise<void> {
    await this.transact('replace', [
      {
        Put: {
          TableName: this.tables[entity],
          Item: item,
          ConditionExpression: 'attribute_exists(id)',
        },
      },
      this.auditPut(audit),
    ]);
  }

  async softDelete(entity: EntityName, id: string, audit: AuditEntry): Promise<void> {
    await this.transact('softDelete', [
      {
        Update: {
          TableName: this.tables[entity],
          Key: { id },
          UpdateExpression: 'SET activa = :f',
          ConditionExpression: 'attribute_exists(id)',
          ExpressionAttributeValues: { ':f': false },
        },
      },
      this.auditPut(audit),
    ]);
  }

  private auditPut(audit: AuditEntry) {
    return {
      Put: { TableName: this.auditTable, Item: audit, ConditionExpression: AUDIT_CONDITION },
    };
  }

  /**
   * Índice 0 = la entidad, índice 1 = la auditoría. Solo un `ConditionalCheckFailed` en el
   * índice 0 es un error de dominio; en el índice 1 (auditoría duplicada) o con cualquier otro
   * motivo se propaga el error original (error interno).
   */
  private async transact(operation: Operation, items: Record<string, unknown>[]): Promise<void> {
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: items }));
    } catch (err) {
      const reasons = canceledReasons(err);
      if (reasons?.[0]?.Code === 'ConditionalCheckFailed') {
        throw operation === 'create' ? new AlreadyExistsError() : new NotFoundError();
      }
      if (reasons?.some((r) => r.Code === 'TransactionConflict')) throw new ConflictError();
      throw err;
    }
  }
}

function canceledReasons(err: unknown): CancellationReason[] | null {
  if (typeof err !== 'object' || err === null) return null;
  const e = err as { name?: unknown; CancellationReasons?: unknown };
  if (e.name !== 'TransactionCanceledException' || !Array.isArray(e.CancellationReasons)) {
    return null;
  }
  return e.CancellationReasons as CancellationReason[];
}

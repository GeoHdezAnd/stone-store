import { GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { quoteIndexKeys, type Quote, type QuoteStatus } from '@canteras/shared';
import type { AuditEntry } from '../lib/audit';

/** Solicitud tal como se guarda: el dominio más las claves de índice y `searchKey`. */
export type StoredQuote = Record<string, unknown>;

/** Clave de continuación de Dynamo (`LastEvaluatedKey`) de uno de los dos índices. */
export type QuoteKey = Record<string, string>;

export interface ListQuery {
  /** `status`: GSI `byStatus` (requiere `status`); `date`: GSI `byDate` (todas). */
  index: 'status' | 'date';
  status?: QuoteStatus;
  /** Rango en la clave de orden `createdAt#quoteId` (ya armado por quien llama). */
  from?: string;
  to?: string;
  /** Texto ya normalizado: `contains(searchKey, :q)`. */
  q?: string;
  limit: number;
  exclusiveStartKey?: QuoteKey;
}

export interface ListPage {
  items: StoredQuote[];
  lastKey: QuoteKey | null;
}

export interface UpdateInput {
  /** Documento completo ya validado, con `rev` incrementado. */
  next: Quote;
  /** `rev` que se leyó: la escritura solo vale si sigue igual. */
  expectedRev: number;
  /** Sin auditoría solo para el reclamo y la liberación del candado de envío (no son cambios de negocio). */
  audit?: AuditEntry;
}

/** Otra persona escribió antes (condición `rev` fallida) o hay una transacción en conflicto. */
export class ConflictError extends Error {
  constructor() {
    super('Conflicto con otro cambio de la solicitud.');
    this.name = 'ConflictError';
  }
}

/**
 * Acceso a datos de `Quotes`. La escritura es ATÓMICA: la solicitud (solo si `rev` sigue igual) y
 * su auditoría en la misma transacción. Las listas usan los GSI (lectura eventualmente
 * consistente); el detalle lee con ConsistentRead.
 */
export interface QuoteRepository {
  get(quoteId: string): Promise<StoredQuote | null>;
  list(query: ListQuery): Promise<ListPage>;
  update(input: UpdateInput): Promise<void>;
  /** Fila `PUBLIC` o `MAIL` de Settings tal como está guardada (con `key`); `null` si no existe. */
  getSettings(key: 'PUBLIC' | 'MAIL'): Promise<Record<string, unknown> | null>;
}

export interface DocClient {
  send(command: unknown): Promise<unknown>;
}

export interface QuoteTables {
  quotes: string;
  auditLog: string;
  byStatusIndex: string;
  byDateIndex: string;
  settings: string;
}

const AUDIT_CONDITION = 'attribute_not_exists(pk) AND attribute_not_exists(sk)';

export class DynamoQuoteRepository implements QuoteRepository {
  constructor(
    private readonly client: DocClient,
    private readonly tables: QuoteTables,
  ) {}

  async get(quoteId: string): Promise<StoredQuote | null> {
    const out = (await this.client.send(
      new GetCommand({
        TableName: this.tables.quotes,
        Key: { quoteId },
        ConsistentRead: true,
      }),
    )) as { Item?: StoredQuote };
    return out.Item ?? null;
  }

  async getSettings(key: 'PUBLIC' | 'MAIL'): Promise<Record<string, unknown> | null> {
    const out = (await this.client.send(
      new GetCommand({ TableName: this.tables.settings, Key: { key }, ConsistentRead: true }),
    )) as { Item?: Record<string, unknown> };
    return out.Item ?? null;
  }

  async list(query: ListQuery): Promise<ListPage> {
    const byStatus = query.index === 'status';
    // `#sk` se agrega solo si hay rango de fechas: DynamoDB rechaza nombres sin usar.
    const names: Record<string, string> = {
      '#pk': byStatus ? 'gsi1pk' : 'gsi2pk',
    };
    if (query.from !== undefined || query.to !== undefined) {
      names['#sk'] = byStatus ? 'gsi1sk' : 'gsi2sk';
    }
    const values: Record<string, unknown> = {
      ':pk': byStatus ? `STATUS#${query.status}` : 'QUOTE',
    };
    let key = '#pk = :pk';
    if (query.from !== undefined && query.to !== undefined) {
      key += ' AND #sk BETWEEN :from AND :to';
      values[':from'] = query.from;
      values[':to'] = query.to;
    } else if (query.from !== undefined) {
      key += ' AND #sk >= :from';
      values[':from'] = query.from;
    } else if (query.to !== undefined) {
      key += ' AND #sk <= :to';
      values[':to'] = query.to;
    }
    let filter: string | undefined;
    if (query.q !== undefined) {
      // El filtro se evalúa DESPUÉS del Limit: una página puede venir vacía con lastKey.
      filter = 'contains(#sk2, :q)';
      names['#sk2'] = 'searchKey';
      values[':q'] = query.q;
    }
    const out = (await this.client.send(
      new QueryCommand({
        TableName: this.tables.quotes,
        IndexName: byStatus ? this.tables.byStatusIndex : this.tables.byDateIndex,
        KeyConditionExpression: key,
        ...(filter === undefined ? {} : { FilterExpression: filter }),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ScanIndexForward: false,
        Limit: query.limit,
        ...(query.exclusiveStartKey ? { ExclusiveStartKey: query.exclusiveStartKey } : {}),
      }),
    )) as { Items?: StoredQuote[]; LastEvaluatedKey?: QuoteKey };
    return { items: out.Items ?? [], lastKey: out.LastEvaluatedKey ?? null };
  }

  async update(input: UpdateInput): Promise<void> {
    const { next, expectedRev, audit } = input;
    const item = { ...next, ...quoteIndexKeys(next) };
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tables.quotes,
                Item: item,
                ConditionExpression: 'attribute_exists(quoteId) AND #rev = :rev',
                ExpressionAttributeNames: { '#rev': 'rev' },
                ExpressionAttributeValues: { ':rev': expectedRev },
              },
            },
            ...(audit === undefined
              ? []
              : [
                  {
                    Put: {
                      TableName: this.tables.auditLog,
                      Item: audit,
                      ConditionExpression: AUDIT_CONDITION,
                    },
                  },
                ]),
          ],
        }),
      );
    } catch (err) {
      if (isConflict(err)) throw new ConflictError();
      throw err;
    }
  }
}

/** Conflicto: falló la condición de la solicitud (índice 0) o hay una transacción en curso. */
function isConflict(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: unknown; CancellationReasons?: unknown };
  if (e.name !== 'TransactionCanceledException' || !Array.isArray(e.CancellationReasons)) {
    return false;
  }
  return (e.CancellationReasons as { Code?: string }[]).some(
    (r, i) => r.Code === 'TransactionConflict' || (i === 0 && r.Code === 'ConditionalCheckFailed'),
  );
}

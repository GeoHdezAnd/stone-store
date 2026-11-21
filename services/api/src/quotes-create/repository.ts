import { FREIGHT_VERSION_PATTERN, MAX_FOLIO_NUMBER, folioCounterName } from '@canteras/shared';
import { BatchGetCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ACTIVE_KEY } from '../admin-freight/repository';

/** El contador del año llegó a 99 999: no caben más folios. */
export class FolioExhaustedError extends Error {
  constructor() {
    super('El contador de folios del año está agotado.');
    this.name = 'FolioExhaustedError';
  }
}

/** Ya existe una solicitud con ese `quoteId` (la condición del Put falló). */
export class DuplicateQuoteError extends Error {
  constructor() {
    super('Ya existe una solicitud con ese id.');
    this.name = 'DuplicateQuoteError';
  }
}

/**
 * Acceso a datos de `POST /quotes`. Solo lo estrictamente necesario (mínimo privilegio): leer la
 * tarifa activa, las piedras pedidas y la fila PUBLIC de Settings; reservar un folio y crear la
 * solicitud. Sin lecturas ni escrituras de otras solicitudes.
 */
export interface QuotesCreateRepository {
  /** Fila de la versión ACTIVA de tarifas (puntero `ACTIVE` y luego la versión), o `null`. */
  getActiveFreightRow(): Promise<Record<string, unknown> | null>;
  /** Piedras por id (las que no existan simplemente no vienen). */
  getStones(ids: readonly string[]): Promise<Record<string, unknown>[]>;
  /** Fila PUBLIC de Settings (patio y correo remitente), o `null`. */
  getPublicSettings(): Promise<Record<string, unknown> | null>;
  /** Reserva el siguiente número de folio del año (ADD atómico). Lanza `FolioExhaustedError` al agotarse. */
  reserveFolioNumber(year: number): Promise<number>;
  /** Crea la solicitud solo si el `quoteId` no existe. Lanza `DuplicateQuoteError` si ya existe. */
  putQuote(item: Record<string, unknown>): Promise<void>;
}

/** Lo mínimo que se usa de `DynamoDBDocumentClient` (se inyecta para probar sin AWS). */
export interface DocClient {
  send(command: unknown): Promise<unknown>;
}

export interface QuotesCreateTables {
  quotes: string;
  counters: string;
  stones: string;
  freightConfig: string;
  settings: string;
}

export interface DynamoQuotesCreateOptions {
  sleep?: (ms: number) => Promise<void>;
}

const MAX_BATCH_ATTEMPTS = 5;
// BatchGetItem admite 100 claves por llamada.
const BATCH_SIZE = 100;

const isConditionFailed = (err: unknown): boolean =>
  typeof err === 'object' &&
  err !== null &&
  (err as { name?: unknown }).name === 'ConditionalCheckFailedException';

export class DynamoQuotesCreateRepository implements QuotesCreateRepository {
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly client: DocClient,
    private readonly tables: QuotesCreateTables,
    options: DynamoQuotesCreateOptions = {},
  ) {
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private async getItem(
    table: string,
    key: Record<string, string>,
  ): Promise<Record<string, unknown> | null> {
    const out = (await this.client.send(
      new GetCommand({ TableName: table, Key: key, ConsistentRead: true }),
    )) as { Item?: Record<string, unknown> };
    return out.Item ?? null;
  }

  async getActiveFreightRow(): Promise<Record<string, unknown> | null> {
    const pointer = await this.getItem(this.tables.freightConfig, { version: ACTIVE_KEY });
    const version = pointer?.['activeVersion'];
    // La versión sale de una fila de DynamoDB: solo se usa como clave si tiene la forma `tNNNN`.
    if (typeof version !== 'string' || !FREIGHT_VERSION_PATTERN.test(version)) return null;
    return this.getItem(this.tables.freightConfig, { version });
  }

  getPublicSettings(): Promise<Record<string, unknown> | null> {
    return this.getItem(this.tables.settings, { key: 'PUBLIC' });
  }

  async getStones(ids: readonly string[]): Promise<Record<string, unknown>[]> {
    const unique = [...new Set(ids)];
    const table = this.tables.stones;
    const found: Record<string, unknown>[] = [];
    for (let i = 0; i < unique.length; i += BATCH_SIZE) {
      let keys: Record<string, unknown>[] = unique.slice(i, i + BATCH_SIZE).map((id) => ({ id }));
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

  async reserveFolioNumber(year: number): Promise<number> {
    const name = folioCounterName(year); // lanza RangeError con un año inválido, antes de llamar a AWS
    try {
      const out = (await this.client.send(
        new UpdateCommand({
          TableName: this.tables.counters,
          Key: { name },
          UpdateExpression: 'ADD #v :n',
          // El contador nunca pasa del tope: evita que reintentos de un atacante lo inflen sin fin.
          ConditionExpression: 'attribute_not_exists(#v) OR #v < :max',
          ExpressionAttributeNames: { '#v': 'value' },
          ExpressionAttributeValues: { ':n': 1, ':max': MAX_FOLIO_NUMBER },
          ReturnValues: 'UPDATED_NEW',
        }),
      )) as { Attributes?: Record<string, unknown> };
      const value = out.Attributes?.['value'];
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
        throw new Error('El contador de folios devolvió un valor inválido.');
      }
      return value;
    } catch (err) {
      if (isConditionFailed(err)) throw new FolioExhaustedError();
      throw err;
    }
  }

  async putQuote(item: Record<string, unknown>): Promise<void> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tables.quotes,
          Item: item,
          ConditionExpression: 'attribute_not_exists(quoteId)',
        }),
      );
    } catch (err) {
      if (isConditionFailed(err)) throw new DuplicateQuoteError();
      throw err;
    }
  }
}

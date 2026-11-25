import { FREIGHT_VERSION_PATTERN } from '@canteras/shared';
import { BatchGetCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ACTIVE_KEY } from '../admin-freight/repository';

/**
 * Acceso a datos de `POST /freight/estimate`. Solo lo estrictamente necesario (mínimo privilegio):
 * leer la tarifa activa, las piedras pedidas y el CP, y leer/escribir la caché de rutas.
 */
export interface FreightEstimateRepository {
  /** Fila de la versión ACTIVA de tarifas (puntero `ACTIVE` y luego la versión), o `null`. */
  getActiveFreightRow(): Promise<Record<string, unknown> | null>;
  /** Piedras por id (las que no existan simplemente no vienen). */
  getStones(ids: readonly string[]): Promise<Record<string, unknown>[]>;
  /** Fila de `PostalCodes` por CP, o `null`. */
  getPostalCode(cp: string): Promise<Record<string, unknown> | null>;
  /** Fila de `RouteCache` por CP, o `null`. */
  getRouteCache(cp: string): Promise<Record<string, unknown> | null>;
  /** Guarda (o sobrescribe) la distancia calculada de un CP. */
  putRouteCache(item: Record<string, unknown>): Promise<void>;
}

/** Lo mínimo que se usa de `DynamoDBDocumentClient` (se inyecta para probar sin AWS). */
export interface DocClient {
  send(command: unknown): Promise<unknown>;
}

export interface FreightEstimateTables {
  freightConfig: string;
  stones: string;
  postalCodes: string;
  routeCache: string;
}

export interface DynamoFreightEstimateOptions {
  sleep?: (ms: number) => Promise<void>;
}

const MAX_BATCH_ATTEMPTS = 5;
// BatchGetItem admite 100 claves por llamada.
const BATCH_SIZE = 100;

export class DynamoFreightEstimateRepository implements FreightEstimateRepository {
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly client: DocClient,
    private readonly tables: FreightEstimateTables,
    options: DynamoFreightEstimateOptions = {},
  ) {
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private async getItem(
    table: string,
    key: Record<string, string>,
    consistent: boolean,
  ): Promise<Record<string, unknown> | null> {
    const out = (await this.client.send(
      new GetCommand({
        TableName: table,
        Key: key,
        ...(consistent ? { ConsistentRead: true } : {}),
      }),
    )) as { Item?: Record<string, unknown> };
    return out.Item ?? null;
  }

  async getActiveFreightRow(): Promise<Record<string, unknown> | null> {
    const pointer = await this.getItem(this.tables.freightConfig, { version: ACTIVE_KEY }, true);
    const version = pointer?.['activeVersion'];
    // La versión sale de una fila de DynamoDB: solo se usa como clave si tiene la forma `tNNNN`.
    if (typeof version !== 'string' || !FREIGHT_VERSION_PATTERN.test(version)) return null;
    return this.getItem(this.tables.freightConfig, { version }, true);
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

  getPostalCode(cp: string): Promise<Record<string, unknown> | null> {
    return this.getItem(this.tables.postalCodes, { cp }, false);
  }

  getRouteCache(cp: string): Promise<Record<string, unknown> | null> {
    return this.getItem(this.tables.routeCache, { cp }, false);
  }

  async putRouteCache(item: Record<string, unknown>): Promise<void> {
    await this.client.send(new PutCommand({ TableName: this.tables.routeCache, Item: item }));
  }
}

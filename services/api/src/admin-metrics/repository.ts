import { BatchGetCommand } from '@aws-sdk/lib-dynamodb';
import {
  queryQuotesIndex,
  type ListPage,
  type ListQuery,
  type QueryClient,
  type QuoteIndexTables,
} from '../lib/quotes-query';

export type { ListPage, ListQuery };

export interface MetricsTables extends QuoteIndexTables {
  postalCodes: string;
}

export interface PostalStates {
  /** Código postal -> estado, solo de los CP que existen. */
  states: Record<string, string>;
  /** CP que DynamoDB no procesó (`UnprocessedKeys`): hay que reintentarlos. */
  unprocessed: string[];
}

/** Máximo de claves de un `BatchGetItem`. */
export const BATCH_GET_MAX_KEYS = 100;

/**
 * Acceso de SOLO LECTURA para el resumen: consultas por los dos índices de `Quotes` (nunca Scan ni
 * la tabla base) y `BatchGetItem` de `PostalCodes`.
 */
export interface MetricsRepository {
  queryQuotes(query: ListQuery): Promise<ListPage>;
  getPostalStates(codes: readonly string[]): Promise<PostalStates>;
}

export class DynamoMetricsRepository implements MetricsRepository {
  constructor(
    private readonly client: QueryClient,
    private readonly tables: MetricsTables,
  ) {}

  queryQuotes(query: ListQuery): Promise<ListPage> {
    return queryQuotesIndex(this.client, this.tables, query);
  }

  async getPostalStates(codes: readonly string[]): Promise<PostalStates> {
    if (codes.length > BATCH_GET_MAX_KEYS) throw new RangeError('Demasiadas claves en el lote.');
    const table = this.tables.postalCodes;
    const out = (await this.client.send(
      new BatchGetCommand({
        RequestItems: {
          [table]: {
            Keys: codes.map((cp) => ({ cp })),
            // Solo lo necesario: nunca lat/lng/colonia.
            ProjectionExpression: '#cp, #estado',
            ExpressionAttributeNames: { '#cp': 'cp', '#estado': 'estado' },
          },
        },
      }),
    )) as {
      Responses?: Record<string, unknown[]>;
      UnprocessedKeys?: Record<string, { Keys?: { cp?: unknown }[] }>;
    };
    const states: Record<string, string> = {};
    for (const row of out.Responses?.[table] ?? []) {
      if (typeof row !== 'object' || row === null) continue;
      const { cp, estado } = row as { cp?: unknown; estado?: unknown };
      if (typeof cp === 'string' && typeof estado === 'string') states[cp] = estado;
    }
    const unprocessed = (out.UnprocessedKeys?.[table]?.Keys ?? [])
      .map((k) => k.cp)
      .filter((cp): cp is string => typeof cp === 'string');
    return { states, unprocessed };
  }
}

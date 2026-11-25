import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { QuoteStatus } from '@canteras/shared';

// Consulta de `Quotes` por sus DOS índices (nunca la tabla base ni Scan). La comparten la lista y
// el CSV de `admin-quotes` y el resumen de `admin-metrics`.

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

export interface QuoteIndexTables {
  quotes: string;
  byStatusIndex: string;
  /** Opcional: quien solo consulta por estado (p. ej. el resumen) no necesita ni recibe permiso del otro. */
  byDateIndex?: string;
}

export interface QueryClient {
  send(command: unknown): Promise<unknown>;
}

export async function queryQuotesIndex(
  client: QueryClient,
  tables: QuoteIndexTables,
  query: ListQuery,
): Promise<ListPage> {
  const byStatus = query.index === 'status';
  if (!byStatus && tables.byDateIndex === undefined) {
    throw new Error('Este módulo no tiene configurado el índice por fecha.');
  }
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
  const out = (await client.send(
    new QueryCommand({
      TableName: tables.quotes,
      IndexName: byStatus ? tables.byStatusIndex : (tables.byDateIndex as string),
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

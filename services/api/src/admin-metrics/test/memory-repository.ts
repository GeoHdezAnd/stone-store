// Repositorio en memoria: SOLO para pruebas. Delega las consultas por índice en el doble de
// `admin-quotes` (mismo orden, rango y paginación que DynamoDB) y simula `BatchGetItem` de
// `PostalCodes`, incluidas las claves sin procesar.
import type { Quote } from '@canteras/shared';
import { MemoryQuoteRepository } from '../../admin-quotes/test/memory-repository';
import type { ListPage, ListQuery } from '../../lib/quotes-query';
import type { MetricsRepository, PostalStates } from '../repository';

export class MemoryMetricsRepository implements MetricsRepository {
  readonly calls: string[] = [];
  readonly queries: ListQuery[] = [];
  readonly batches: string[][] = [];
  readonly postalCodes = new Map<string, string>();
  /** CP que la primera vez se devuelven como `UnprocessedKeys` (y luego sí se resuelven). */
  unprocessedOnce = new Set<string>();
  /** CP que SIEMPRE se devuelven sin procesar. */
  alwaysUnprocessed = new Set<string>();
  /** Si se define, la consulta de solicitudes lanza este error. */
  queryError: Error | null = null;
  private readonly quotes = new MemoryQuoteRepository();
  private served = new Set<string>();

  seed(q: Quote): void {
    this.quotes.seed(q);
  }
  /** Siembra una fila cruda (p. ej. inválida) con claves de índice a mano. */
  seedRaw(row: Record<string, unknown>): void {
    this.quotes.rows.set(String(row['quoteId']), structuredClone(row));
  }

  async queryQuotes(query: ListQuery): Promise<ListPage> {
    this.calls.push('query');
    this.queries.push(query);
    if (this.queryError) throw this.queryError;
    return this.quotes.list(query);
  }

  async getPostalStates(codes: readonly string[]): Promise<PostalStates> {
    this.calls.push('batchGet');
    this.batches.push([...codes]);
    const states: Record<string, string> = {};
    const unprocessed: string[] = [];
    for (const cp of codes) {
      const hold =
        this.alwaysUnprocessed.has(cp) || (this.unprocessedOnce.has(cp) && !this.served.has(cp));
      if (hold) {
        this.served.add(cp);
        unprocessed.push(cp);
        continue;
      }
      const estado = this.postalCodes.get(cp);
      if (estado !== undefined) states[cp] = estado;
    }
    return { states, unprocessed };
  }
}

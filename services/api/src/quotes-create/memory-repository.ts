// Repositorio en memoria: SOLO para pruebas. Imita las condiciones de DynamoDB (el contador tiene
// tope, el Put exige que el quoteId no exista) y registra el orden de las llamadas. Permite
// inyectar un error por método para probar los caminos de fallo.
import { MAX_FOLIO_NUMBER } from '@canteras/shared';
import {
  DuplicateQuoteError,
  FolioExhaustedError,
  type QuotesCreateRepository,
} from './repository';

export type MemoryMethod =
  'getActiveFreightRow' | 'getStones' | 'getPublicSettings' | 'reserveFolioNumber' | 'putQuote';

export class MemoryQuotesCreateRepository implements QuotesCreateRepository {
  readonly calls: string[] = [];
  readonly quotes = new Map<string, Record<string, unknown>>();
  readonly counters = new Map<number, number>();
  readonly stones = new Map<string, Record<string, unknown>>();
  activeFreight: Record<string, unknown> | null = null;
  publicSettings: Record<string, unknown> | null = null;
  /** Si hay un error para el método, se lanza (después de registrar la llamada). */
  readonly failOn = new Map<MemoryMethod, Error>();

  private enter(method: MemoryMethod): void {
    this.calls.push(method);
    const err = this.failOn.get(method);
    if (err) throw err;
  }

  async getActiveFreightRow(): Promise<Record<string, unknown> | null> {
    this.enter('getActiveFreightRow');
    return this.activeFreight ? structuredClone(this.activeFreight) : null;
  }

  async getStones(ids: readonly string[]): Promise<Record<string, unknown>[]> {
    this.enter('getStones');
    return [...new Set(ids)].flatMap((id) =>
      this.stones.has(id) ? [structuredClone(this.stones.get(id) as Record<string, unknown>)] : [],
    );
  }

  async getPublicSettings(): Promise<Record<string, unknown> | null> {
    this.enter('getPublicSettings');
    return this.publicSettings ? structuredClone(this.publicSettings) : null;
  }

  async reserveFolioNumber(year: number): Promise<number> {
    this.enter('reserveFolioNumber');
    const current = this.counters.get(year) ?? 0;
    if (current >= MAX_FOLIO_NUMBER) throw new FolioExhaustedError();
    this.counters.set(year, current + 1);
    return current + 1;
  }

  async putQuote(item: Record<string, unknown>): Promise<void> {
    this.enter('putQuote');
    const id = String(item['quoteId']);
    if (this.quotes.has(id)) throw new DuplicateQuoteError();
    this.quotes.set(id, structuredClone(item));
  }
}

// Repositorio en memoria: SOLO para pruebas. Imita las consultas por índice (orden descendente
// por `sk`, rango, `Limit` ANTES del filtro `contains`, `LastEvaluatedKey`) y la condición de
// `rev` de la transacción. Registra llamadas y auditorías.
import { quoteIndexKeys, type Quote } from '@canteras/shared';
import type { AuditEntry } from '../../lib/audit';
import {
  ConflictError,
  type ListPage,
  type ListQuery,
  type QuoteKey,
  type QuoteRepository,
  type StoredQuote,
  type UpdateInput,
} from '../repository';

export class MemoryQuoteRepository implements QuoteRepository {
  readonly calls: string[] = [];
  readonly audits: AuditEntry[] = [];
  readonly rows = new Map<string, StoredQuote>();
  readonly settings = new Map<'PUBLIC' | 'MAIL' | 'QUOTING', Record<string, unknown>>();
  lastList: ListQuery | null = null;
  /** Se ejecuta justo antes de aplicar una escritura (simula que otro escribió antes). */
  onBeforeWrite: ((writeNumber: number) => void) | null = null;
  /** Si se define, la siguiente escritura lanza este error sin guardar nada. */
  writeError: Error | null = null;
  /** Número de escritura (1, 2...) en la que se lanza `writeError` (por defecto la primera). */
  writeErrorOn = 1;
  private writes = 0;

  /** Siembra una solicitud con sus claves de índice (no cuenta como llamada). */
  seed(q: Quote): void {
    this.rows.set(q.quoteId, structuredClone({ ...q, ...quoteIndexKeys(q) }) as StoredQuote);
  }

  async get(quoteId: string): Promise<StoredQuote | null> {
    this.calls.push(`get:${quoteId}`);
    const row = this.rows.get(quoteId);
    return row ? structuredClone(row) : null;
  }

  async getSettings(key: 'PUBLIC' | 'MAIL'): Promise<Record<string, unknown> | null> {
    this.calls.push(`settings:${key}`);
    const row = this.settings.get(key);
    return row ? structuredClone(row) : null;
  }

  async list(query: ListQuery): Promise<ListPage> {
    this.calls.push('list');
    this.lastList = query;
    const byStatus = query.index === 'status';
    const pk = byStatus ? 'gsi1pk' : 'gsi2pk';
    const sk = byStatus ? 'gsi1sk' : 'gsi2sk';
    const wantPk = byStatus ? `STATUS#${query.status}` : 'QUOTE';
    let rows = [...this.rows.values()]
      .filter((r) => r[pk] === wantPk && typeof r[sk] === 'string')
      .sort((a, b) => (String(a[sk]) < String(b[sk]) ? 1 : -1));
    if (query.from !== undefined) rows = rows.filter((r) => String(r[sk]) >= query.from!);
    if (query.to !== undefined) rows = rows.filter((r) => String(r[sk]) <= query.to!);
    const start = query.exclusiveStartKey;
    if (start) {
      const at = rows.findIndex((r) => r['quoteId'] === start['quoteId']);
      rows = at === -1 ? rows.filter((r) => String(r[sk]) < String(start[sk])) : rows.slice(at + 1);
    }
    const slice = rows.slice(0, query.limit);
    const last = slice[slice.length - 1];
    const lastKey: QuoteKey | null =
      rows.length > query.limit && last
        ? ({ quoteId: last['quoteId'], [pk]: last[pk], [sk]: last[sk] } as QuoteKey)
        : null;
    // El filtro se aplica DESPUÉS del límite (igual que DynamoDB).
    const items = slice.filter(
      (r) => query.q === undefined || String(r['searchKey']).includes(query.q),
    );
    return { items: structuredClone(items), lastKey };
  }

  async update(input: UpdateInput): Promise<void> {
    this.calls.push('update');
    const n = ++this.writes;
    this.onBeforeWrite?.(n);
    if (this.writeError && n >= this.writeErrorOn) throw this.writeError;
    const cur = this.rows.get(input.next.quoteId);
    if (cur === undefined || cur['rev'] !== input.expectedRev) throw new ConflictError();
    this.rows.set(
      input.next.quoteId,
      structuredClone({ ...input.next, ...quoteIndexKeys(input.next) }) as StoredQuote,
    );
    if (input.audit) this.audits.push(structuredClone(input.audit));
  }
}

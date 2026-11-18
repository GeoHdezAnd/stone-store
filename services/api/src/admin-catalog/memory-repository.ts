// Repositorio en memoria: SOLO para pruebas. Imita las condiciones de DynamoDB
// (no existe / existe) y registra cada llamada y cada entrada de auditoría.
import type { AuditEntry } from '../lib/audit';
import {
  AlreadyExistsError,
  NotFoundError,
  type CatalogItem,
  type CatalogRepository,
  type EntityName,
  type ListPage,
  type ListParams,
} from './repository';

export class MemoryCatalogRepository implements CatalogRepository {
  readonly calls: string[] = [];
  readonly audits: AuditEntry[] = [];
  private readonly data: Record<EntityName, Map<string, Record<string, unknown>>> = {
    stone: new Map(),
    project: new Map(),
    finish: new Map(),
    service: new Map(),
  };

  /** Inserta tal cual (incluso datos inválidos) sin registrar llamadas ni auditoría. */
  seedRaw(entity: EntityName, item: Record<string, unknown>): void {
    this.data[entity].set(String(item['id']), structuredClone(item));
  }

  async get(entity: EntityName, id: string): Promise<Record<string, unknown> | null> {
    this.calls.push('get');
    const found = this.data[entity].get(id);
    return found ? structuredClone(found) : null;
  }

  async list(entity: EntityName, params: ListParams): Promise<ListPage> {
    this.calls.push('list');
    const ids = [...this.data[entity].keys()].sort();
    const start = params.exclusiveStartKey
      ? ids.findIndex((id) => id > (params.exclusiveStartKey as { id: string }).id)
      : 0;
    const slice = start === -1 ? [] : ids.slice(start, start + params.limit);
    const last = slice.at(-1);
    const hasMore = start !== -1 && start + params.limit < ids.length;
    return {
      items: slice.map(
        (id) => structuredClone(this.data[entity].get(id)) as Record<string, unknown>,
      ),
      lastKey: hasMore && last !== undefined ? { id: last } : null,
    };
  }

  async existsAll(entity: EntityName, ids: readonly string[]): Promise<string[]> {
    this.calls.push('existsAll');
    return [...new Set(ids)].filter((id) => !this.data[entity].has(id));
  }

  async create(entity: EntityName, item: CatalogItem, audit: AuditEntry): Promise<void> {
    this.calls.push('create');
    if (this.data[entity].has(item.id)) throw new AlreadyExistsError();
    this.data[entity].set(item.id, structuredClone(item));
    this.audits.push(structuredClone(audit));
  }

  async replace(entity: EntityName, item: CatalogItem, audit: AuditEntry): Promise<void> {
    this.calls.push('replace');
    if (!this.data[entity].has(item.id)) throw new NotFoundError();
    this.data[entity].set(item.id, structuredClone(item));
    this.audits.push(structuredClone(audit));
  }

  async softDelete(entity: EntityName, id: string, audit: AuditEntry): Promise<void> {
    this.calls.push('softDelete');
    const current = this.data[entity].get(id);
    if (!current) throw new NotFoundError();
    current['activa'] = false;
    this.audits.push(structuredClone(audit));
  }
}

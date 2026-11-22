// Repositorio en memoria: SOLO para pruebas. Imita las condiciones de la transacción de DynamoDB
// y registra cada llamada y cada auditoría.
import type { AuditEntry } from '../../lib/audit';
import {
  ConflictError,
  CURRENT_KEY,
  type CommitInput,
  type CurrentRow,
  type PendingPage,
  type PublicationRow,
  type PublishRepository,
  type RawCatalog,
} from '../repository';

export class MemoryPublishRepository implements PublishRepository {
  readonly calls: string[] = [];
  readonly audits: AuditEntry[] = [];
  readonly rows = new Map<string, PublicationRow>();
  current: CurrentRow | null = null;
  catalog: RawCatalog = {
    stones: [],
    projects: [],
    finishes: [],
    services: [],
    publicSettings: null,
  };
  /** Cambios pendientes simulados (ya en el formato del índice). */
  pendingAudits: Record<string, unknown>[] = [];
  /** Se ejecuta justo antes de aplicar `commit` (para simular que otro publicó antes). */
  onBeforeCommit: (() => void) | null = null;
  /** Si se define, el siguiente `commit` lanza este error sin guardar nada. */
  commitError: Error | null = null;
  lastPendingSince: string | null | undefined;

  async readCatalog(): Promise<RawCatalog> {
    this.calls.push('readCatalog');
    return structuredClone(this.catalog);
  }

  async getCurrent(): Promise<CurrentRow | null> {
    this.calls.push('getCurrent');
    return this.current ? structuredClone(this.current) : null;
  }

  async getPublication(version: string): Promise<PublicationRow | null> {
    this.calls.push(`getPublication:${version}`);
    const row = this.rows.get(version);
    return row ? structuredClone(row) : null;
  }

  async getPublications(versions: readonly string[]): Promise<PublicationRow[]> {
    this.calls.push('getPublications');
    return versions
      .flatMap((v) =>
        this.rows.has(v) ? [structuredClone(this.rows.get(v) as PublicationRow)] : [],
      )
      .sort((a, b) => (a.version < b.version ? 1 : -1));
  }

  async listPending(since: string | null, limit: number): Promise<PendingPage> {
    this.calls.push('listPending');
    this.lastPendingSince = since;
    const rows = this.pendingAudits.slice(0, limit + 1);
    const items = rows.slice(0, limit).map((r) => {
      const [, entity, ...id] = String(r['pk']).split('#');
      return {
        entity: entity as string,
        id: id.join('#'),
        at: String(r['sk']).split('#')[0] as string,
        accion: String(r['accion']),
        userId: String(r['userId']),
      };
    });
    return { items, truncated: rows.length > limit };
  }

  async commit(input: CommitInput): Promise<void> {
    this.calls.push('commit');
    this.onBeforeCommit?.();
    if (this.commitError) throw this.commitError;
    const { baseVersion, publication, audit } = input;
    if (this.rows.has(publication.version)) throw new ConflictError();
    if ((this.current?.currentVersion ?? null) !== baseVersion) throw new ConflictError();
    this.rows.set(publication.version, structuredClone(publication));
    this.current = {
      version: CURRENT_KEY,
      currentVersion: publication.version,
      action: publication.action,
      hash: publication.hash,
      generatedAt: publication.generatedAt,
      publishedAt: publication.publishedAt,
      publishedBy: publication.publishedBy,
    };
    this.audits.push(structuredClone(audit));
  }
}

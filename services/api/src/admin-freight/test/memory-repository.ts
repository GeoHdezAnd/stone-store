// Repositorio en memoria: SOLO para pruebas. Imita las condiciones de las transacciones de
// DynamoDB (versión nueva solo si no existe; puntero solo si sigue como se leyó) y registra
// cada llamada y cada auditoría.
import type { AuditEntry } from '../../lib/audit';
import {
  ACTIVE_KEY,
  ConflictError,
  type CreateVersionInput,
  type FreightRepository,
  type PointerRow,
  type SetActiveInput,
  type VersionRow,
} from '../repository';

export class MemoryFreightRepository implements FreightRepository {
  readonly calls: string[] = [];
  readonly audits: AuditEntry[] = [];
  readonly rows = new Map<string, VersionRow>();
  readonly stones = new Map<string, Record<string, unknown>>();
  pointer: PointerRow | null = null;
  /** Se ejecuta justo antes de aplicar una escritura (para simular que otro escribió antes). */
  onBeforeWrite: (() => void) | null = null;
  /** Si se define, la siguiente escritura lanza este error sin guardar nada. */
  writeError: Error | null = null;

  async getPointer(): Promise<PointerRow | null> {
    this.calls.push('getPointer');
    return this.pointer ? structuredClone(this.pointer) : null;
  }

  async getVersion(version: string): Promise<VersionRow | null> {
    this.calls.push(`getVersion:${version}`);
    const row = this.rows.get(version);
    return row ? structuredClone(row) : null;
  }

  async getVersions(versions: readonly string[]): Promise<VersionRow[]> {
    this.calls.push('getVersions');
    return versions
      .flatMap((v) => (this.rows.has(v) ? [structuredClone(this.rows.get(v) as VersionRow)] : []))
      .sort((a, b) => (String(a['version']) < String(b['version']) ? 1 : -1));
  }

  async getStones(ids: readonly string[]): Promise<Record<string, unknown>[]> {
    this.calls.push('getStones');
    return [...new Set(ids)].flatMap((id) =>
      this.stones.has(id) ? [structuredClone(this.stones.get(id) as Record<string, unknown>)] : [],
    );
  }

  private checkPointer(base: PointerRow | null): void {
    const cur = this.pointer;
    if (base === null) {
      if (cur !== null) throw new ConflictError();
      return;
    }
    if (
      cur === null ||
      cur.latestVersion !== base.latestVersion ||
      cur.activeVersion !== base.activeVersion
    ) {
      throw new ConflictError();
    }
  }

  async createVersion(input: CreateVersionInput): Promise<void> {
    this.calls.push('createVersion');
    this.onBeforeWrite?.();
    if (this.writeError) throw this.writeError;
    const { basePointer, row, pointer, audit } = input;
    if (this.rows.has(row.version)) throw new ConflictError();
    this.checkPointer(basePointer);
    this.rows.set(row.version, structuredClone(row));
    this.pointer = { ...structuredClone(pointer), version: ACTIVE_KEY };
    this.audits.push(structuredClone(audit));
  }

  async setActive(input: SetActiveInput): Promise<void> {
    this.calls.push('setActive');
    this.onBeforeWrite?.();
    if (this.writeError) throw this.writeError;
    this.checkPointer(input.basePointer);
    this.pointer = structuredClone(input.pointer);
    this.audits.push(structuredClone(input.audit));
  }
}

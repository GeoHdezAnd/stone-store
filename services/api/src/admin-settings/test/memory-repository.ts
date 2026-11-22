// Repositorio en memoria: SOLO para pruebas. Imita el UPSERT de DynamoDB y registra cada
// llamada y cada entrada de auditoría.
import type { AuditEntry } from '../../lib/audit';
import type { SettingsRepository, SettingsRowKey } from '../repository';

export class MemorySettingsRepository implements SettingsRepository {
  readonly calls: string[] = [];
  readonly audits: AuditEntry[] = [];
  /** Si se define, el siguiente `put` lanza este error sin guardar nada. */
  putError: Error | null = null;
  private readonly rows = new Map<SettingsRowKey, Record<string, unknown>>();

  /** Inserta tal cual (incluso datos inválidos) sin registrar llamadas ni auditoría. */
  seedRaw(key: SettingsRowKey, item: Record<string, unknown>): void {
    this.rows.set(key, structuredClone(item));
  }

  async get(key: SettingsRowKey): Promise<Record<string, unknown> | null> {
    this.calls.push(`get:${key}`);
    const found = this.rows.get(key);
    return found ? structuredClone(found) : null;
  }

  async put(key: SettingsRowKey, data: Record<string, unknown>, audit: AuditEntry): Promise<void> {
    this.calls.push(`put:${key}`);
    if (this.putError) throw this.putError;
    this.rows.set(key, { ...structuredClone(data), key });
    this.audits.push(structuredClone(audit));
  }
}

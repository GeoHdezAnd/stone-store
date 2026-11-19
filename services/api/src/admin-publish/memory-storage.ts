// Almacén en memoria: SOLO para pruebas. Registra el orden de las operaciones.
import {
  ObjectExistsError,
  ObjectMissingError,
  CURRENT_COPY_KEY,
  immutableKey,
  type PublishStorage,
} from './storage';

export class MemoryPublishStorage implements PublishStorage {
  readonly objects = new Map<string, string>();
  readonly calls: string[] = [];
  /** Errores a lanzar en la siguiente llamada de cada operación. */
  failPutImmutable: Error | null = null;
  failCopy: Error | null = null;

  async putImmutable(
    version: string,
    body: string,
    options: { overwrite: boolean },
  ): Promise<void> {
    this.calls.push(`putImmutable:${version}${options.overwrite ? ':overwrite' : ''}`);
    if (this.failPutImmutable) throw this.failPutImmutable;
    const key = immutableKey(version);
    if (!options.overwrite && this.objects.has(key)) throw new ObjectExistsError();
    this.objects.set(key, body);
  }

  async getImmutable(version: string): Promise<string> {
    this.calls.push(`getImmutable:${version}`);
    const found = this.objects.get(immutableKey(version));
    if (found === undefined) throw new ObjectMissingError();
    return found;
  }

  async putCurrentCopy(body: string): Promise<void> {
    this.calls.push('putCurrentCopy');
    if (this.failCopy) throw this.failCopy;
    this.objects.set(CURRENT_COPY_KEY, body);
  }
}

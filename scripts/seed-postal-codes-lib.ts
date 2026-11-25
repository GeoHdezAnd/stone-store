/**
 * Lógica pura del seed de códigos postales (sin AWS): lee `content/postal-codes.json`, lo valida
 * con `postalCodeFileSchema` de `packages/shared` y decide qué filas faltan. La escritura a
 * DynamoDB vive en `seed-postal-codes.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { postalCodeFileSchema, type PostalCode } from '../packages/shared/src/index';

export { checkSeedEnv } from './seed-freight-lib';

/** `BatchWriteItem` admite hasta 25 escrituras por llamada. */
export const BATCH_WRITE_SIZE = 25;

export class PostalCodesSeedValidationError extends Error {
  public constructor(public readonly errors: readonly string[]) {
    super(`Los códigos postales de ejemplo no son válidos:\n- ${errors.join('\n- ')}`);
    this.name = 'PostalCodesSeedValidationError';
  }
}

export function readPostalCodesContent(dir: string): unknown {
  return JSON.parse(readFileSync(join(dir, 'postal-codes.json'), 'utf8'));
}

/** Valida el archivo completo (debe estar marcado `ejemplo: true`) y devuelve las filas. */
export function buildPostalCodesSeed(raw: unknown): PostalCode[] {
  const parsed = postalCodeFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PostalCodesSeedValidationError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`),
    );
  }
  return parsed.data.items;
}

export function chunk<T>(list: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError('El tamaño del lote es inválido.');
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * `BatchWriteItem` no admite condiciones (sobrescribiría), así que el script primero consulta
 * cuáles `cp` ya existen y solo escribe los que faltan. Hay una ventana mínima de carrera entre
 * la consulta y la escritura: aceptable para un seed manual.
 */
export function selectNewPostalCodes(
  items: readonly PostalCode[],
  existing: ReadonlySet<string>,
): { toWrite: PostalCode[]; skipped: number } {
  const toWrite = items.filter((i) => !existing.has(i.cp));
  return { toWrite, skipped: items.length - toWrite.length };
}

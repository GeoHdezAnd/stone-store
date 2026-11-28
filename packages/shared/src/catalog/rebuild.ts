import { CATALOG_VERSION_PATTERN } from './document';

// Lógica PURA del loader del sitio cuando el build lo dispara la publicación del catálogo
// (CLAUDE.md 5.2 y 6.1). Sin I/O: el loader de `apps/web` solo la consulta.

/** Tope del `catalog.json` descargado (el seed ×10 sigue muy por debajo). */
export const CATALOG_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Intentos para ver la versión mínima exigida: `/published/*` se sirve con caché de CloudFront
 * (`max-age=60`) y la invalidación es asíncrona, así que la copia vieja puede tardar en irse.
 */
export const CATALOG_MIN_VERSION_ATTEMPTS = 6;

/** Espera entre intentos (ms). */
export const CATALOG_MIN_VERSION_WAIT_MS = 15_000;

function sequenceOf(version: string): bigint {
  if (!CATALOG_VERSION_PATTERN.test(version)) {
    throw new Error(`Versión de catálogo no válida: ${version}`);
  }
  return BigInt(version.slice(1));
}

/** Compara `vNNNN` por su número (no como texto: `v10000` es mayor que `v9999`). */
export function compareCatalogVersions(a: string, b: string): number {
  const x = sequenceOf(a);
  const y = sequenceOf(b);
  return x === y ? 0 : x > y ? 1 : -1;
}

export interface CatalogBuildOptions {
  /** Si la URL del catálogo falla, el build FALLA en vez de usar el seed. */
  required: boolean;
  /** Versión mínima que debe tener el catálogo descargado; `null` = sin exigencia. */
  minVersion: string | null;
}

/**
 * Lee `CATALOG_REQUIRED` y `CATALOG_MIN_VERSION` del entorno de build.
 * `CATALOG_REQUIRED`: `'1'` = requerido; ausente, `''` o `'0'` = no requerido; CUALQUIER otro valor
 * (`true`, `yes`, ` 1`…) lanza: un error de dedo no debe desactivar en silencio la protección y
 * dejar que el build publique el seed de ejemplo.
 */
export function readCatalogBuildOptions(
  env: Record<string, string | undefined>,
): CatalogBuildOptions {
  const min = env['CATALOG_MIN_VERSION'];
  if (min !== undefined && min !== '' && !CATALOG_VERSION_PATTERN.test(min)) {
    throw new Error('CATALOG_MIN_VERSION debe tener la forma vNNNN (por ejemplo v0007).');
  }
  const requiredRaw = env['CATALOG_REQUIRED'];
  if (
    requiredRaw !== undefined &&
    requiredRaw !== '' &&
    requiredRaw !== '0' &&
    requiredRaw !== '1'
  ) {
    throw new Error("CATALOG_REQUIRED debe ser '1' (requerido) o '0'/vacío (no requerido).");
  }
  return {
    required: requiredRaw === '1',
    minVersion: min === undefined || min === '' ? null : min,
  };
}

/** `true` si el tamaño no es válido o rebasa el tope. */
export function catalogSizeExceeded(bytes: number, max: number = CATALOG_MAX_BYTES): boolean {
  return !Number.isFinite(bytes) || bytes < 0 || bytes > max;
}

export type CatalogVersionDecision =
  { action: 'accept' } | { action: 'retry' } | { action: 'fail'; reason: 'version_too_old' };

/** Decide qué hacer con la versión descargada frente a la mínima exigida. */
export function decideCatalogVersion(input: {
  minVersion: string | null;
  version: string;
  attempt: number;
  maxAttempts: number;
}): CatalogVersionDecision {
  if (input.minVersion === null) return { action: 'accept' };
  if (compareCatalogVersions(input.version, input.minVersion) >= 0) return { action: 'accept' };
  return input.attempt < input.maxAttempts
    ? { action: 'retry' }
    : { action: 'fail', reason: 'version_too_old' };
}

/** Qué hacer cuando la URL del catálogo no se pudo leer. */
export function decideUrlFailure(input: { required: boolean }): 'use_seed' | 'fail' {
  return input.required ? 'fail' : 'use_seed';
}

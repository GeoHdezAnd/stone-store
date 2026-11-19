/**
 * Lógica pura del seed de tarifas de flete (sin AWS): lee `content/freight-config.json`, lo valida
 * con `freightConfigSchema` de `packages/shared` y arma la fila de la versión `t0001` y la fila
 * puntero `ACTIVE`. La escritura a DynamoDB vive en `seed-freight.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { freightConfigSchema } from '../packages/shared/src/index';

/** El seed siempre crea la PRIMERA versión. */
export const SEED_VERSION = 't0001';
const SEED_USER = 'seed';
// Debe coincidir con `ACTIVE_KEY` de services/api/src/admin-freight/repository.ts (hay un test).
const ACTIVE_KEY = 'ACTIVE';

export interface FreightSeed {
  row: Record<string, unknown> & { version: string };
  pointer: {
    version: typeof ACTIVE_KEY;
    activeVersion: string;
    latestVersion: string;
    activadaPor: string;
    activadaAt: string;
  };
}

export class FreightSeedValidationError extends Error {
  public constructor(public readonly errors: readonly string[]) {
    super(`La configuración de flete de ejemplo no es válida:\n- ${errors.join('\n- ')}`);
    this.name = 'FreightSeedValidationError';
  }
}

export function readFreightContent(dir: string): unknown {
  return JSON.parse(readFileSync(join(dir, 'freight-config.json'), 'utf8'));
}

/**
 * Valida y arma el seed. `nowIso` es la fecha de creación/activación (se inyecta para probar).
 * Solo acepta datos marcados `ejemplo: true`: las tarifas reales se capturan en el dashboard.
 */
export function buildFreightSeed(raw: unknown, nowIso: string): FreightSeed {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new FreightSeedValidationError(['freight-config.json debe ser un objeto JSON']);
  }
  const candidate = {
    ...(raw as Record<string, unknown>),
    version: SEED_VERSION,
    creadaPor: SEED_USER,
    creadaAt: nowIso,
  };
  const parsed = freightConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new FreightSeedValidationError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`),
    );
  }
  if (parsed.data.ejemplo !== true) {
    throw new FreightSeedValidationError([
      'freight-config.json debe estar marcado con "ejemplo": true (el seed solo carga datos de ejemplo)',
    ]);
  }
  // `activa` es derivada (del puntero): nunca se guarda en la fila de la versión.
  const { activa: _activa, ...row } = parsed.data;
  void _activa;
  return {
    row,
    pointer: {
      version: ACTIVE_KEY,
      activeVersion: SEED_VERSION,
      latestVersion: SEED_VERSION,
      activadaPor: SEED_USER,
      activadaAt: nowIso,
    },
  };
}

/** Mismas salvaguardas que `seed.ts`. Devuelve el entorno. */
export function checkSeedEnv(env: Record<string, string | undefined>): 'dev' | 'prod' {
  const appEnv = env['APP_ENV'] ?? 'dev';
  if (appEnv !== 'dev' && appEnv !== 'prod') {
    throw new Error(`APP_ENV inválido: "${appEnv}". Usa "dev" o "prod".`);
  }
  if (appEnv === 'prod' && env['AWS_ENDPOINT_URL']) {
    throw new Error('APP_ENV=prod no puede usar AWS_ENDPOINT_URL (emulador).');
  }
  if (appEnv === 'prod' && env['SEED_CONFIRM_PROD'] !== 'si') {
    throw new Error('Para cargar datos en prod define SEED_CONFIRM_PROD=si. Abortado.');
  }
  return appEnv;
}

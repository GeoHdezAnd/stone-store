import type { FreightTables } from './repository';

export type FreightConfigEnv = FreightTables;

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new Error(`Falta la variable de entorno ${name}.`);
  }
  return value;
}

/** Lee las variables de entorno; si falta alguna lanza un error claro. */
export function loadConfig(env: Record<string, string | undefined>): FreightConfigEnv {
  return {
    freightConfig: required(env, 'FREIGHT_CONFIG_TABLE'),
    stones: required(env, 'STONES_TABLE'),
    auditLog: required(env, 'AUDIT_TABLE'),
  };
}

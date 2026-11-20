import type { QuoteTables } from './repository';

export type QuotesConfigEnv = QuoteTables;

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new Error(`Falta la variable de entorno ${name}.`);
  }
  return value;
}

/** Lee las variables de entorno; si falta alguna lanza un error claro. */
export function loadConfig(env: Record<string, string | undefined>): QuotesConfigEnv {
  return {
    quotes: required(env, 'QUOTES_TABLE'),
    auditLog: required(env, 'AUDIT_TABLE'),
    byStatusIndex: required(env, 'QUOTES_BY_STATUS_INDEX'),
    byDateIndex: required(env, 'QUOTES_BY_DATE_INDEX'),
    settings: required(env, 'SETTINGS_TABLE'),
  };
}

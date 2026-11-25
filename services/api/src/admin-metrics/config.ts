import type { MetricsTables } from './repository';

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new Error(`Falta la variable de entorno ${name}.`);
  }
  return value;
}

/** Lee las variables de entorno; si falta alguna lanza un error claro. */
export function loadConfig(env: Record<string, string | undefined>): MetricsTables {
  return {
    quotes: required(env, 'QUOTES_TABLE'),
    byStatusIndex: required(env, 'QUOTES_BY_STATUS_INDEX'),
    postalCodes: required(env, 'POSTAL_CODES_TABLE'),
  };
}

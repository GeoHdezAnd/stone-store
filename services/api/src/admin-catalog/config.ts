import { ENTITY_NAMES, TABLE_ENV } from './entities';
import type { EntityName } from './repository';

export interface CatalogConfig {
  tables: Record<EntityName, string>;
  auditTable: string;
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new Error(`Falta la variable de entorno ${name}.`);
  }
  return value;
}

/** Lee las 5 variables de entorno; si falta alguna lanza un error claro. */
export function loadConfig(env: Record<string, string | undefined>): CatalogConfig {
  const tables = {} as Record<EntityName, string>;
  for (const name of ENTITY_NAMES) tables[name] = required(env, TABLE_ENV[name]);
  return { tables, auditTable: required(env, 'AUDIT_TABLE') };
}

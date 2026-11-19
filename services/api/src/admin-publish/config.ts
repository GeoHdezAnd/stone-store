import type { PublishTables } from './repository';

export interface PublishConfig {
  tables: PublishTables;
  bucket: string;
  /** Sin valor = no se invalida CloudFront (`NoopInvalidator`). */
  siteDistributionId: string | undefined;
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new Error(`Falta la variable de entorno ${name}.`);
  }
  return value;
}

/** Lee las variables de entorno; si falta alguna obligatoria lanza un error claro. */
export function loadConfig(env: Record<string, string | undefined>): PublishConfig {
  const distribution = env['SITE_DISTRIBUTION_ID'];
  return {
    tables: {
      stones: required(env, 'STONES_TABLE'),
      projects: required(env, 'PROJECTS_TABLE'),
      finishes: required(env, 'FINISHES_TABLE'),
      services: required(env, 'SERVICES_TABLE'),
      settings: required(env, 'SETTINGS_TABLE'),
      publications: required(env, 'PUBLICATIONS_TABLE'),
      auditLog: required(env, 'AUDIT_TABLE'),
      auditScopeIndex: required(env, 'AUDIT_SCOPE_INDEX'),
    },
    bucket: required(env, 'PUBLISH_BUCKET'),
    siteDistributionId:
      distribution === undefined || distribution === '' ? undefined : distribution,
  };
}

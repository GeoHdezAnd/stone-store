import type { PublishTables } from './repository';
import { isValidRef, isValidRepository, isValidWorkflowFile } from './site-rebuild';

/** Datos para pedir la reconstrucción del sitio a GitHub Actions. */
export interface SiteRebuildConfig {
  /** Nombre del parámetro SSM (SecureString) con el token de GitHub. */
  tokenParam: string;
  repository: string;
  workflowFile: string;
  ref: string;
}

export interface PublishConfig {
  tables: PublishTables;
  bucket: string;
  /** Sin valor = no se invalida CloudFront (`NoopInvalidator`). */
  siteDistributionId: string | undefined;
  /** Sin valor (faltan variables, hay alguna mal formada o es emulador) = `NoopRebuilder`. */
  siteRebuild: SiteRebuildConfig | undefined;
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new Error(`Falta la variable de entorno ${name}.`);
  }
  return value;
}

function loadSiteRebuild(env: Record<string, string | undefined>): SiteRebuildConfig | undefined {
  const tokenParam = env['SITE_REBUILD_TOKEN_PARAM'];
  const repository = env['SITE_REBUILD_REPOSITORY'];
  const workflowFile = env['SITE_REBUILD_WORKFLOW'];
  const ref = env['SITE_REBUILD_REF'];
  // Parcial o mal formada: no se dispara (la publicación sigue funcionando y avisa not_configured).
  if (!tokenParam || !repository || !workflowFile || !ref) return undefined;
  if (!isValidRepository(repository) || !isValidWorkflowFile(workflowFile) || !isValidRef(ref)) {
    return undefined;
  }
  return { tokenParam, repository, workflowFile, ref };
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
    siteRebuild: loadSiteRebuild(env),
  };
}

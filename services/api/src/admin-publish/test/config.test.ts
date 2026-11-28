import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config';

const env = {
  STONES_TABLE: 's',
  PROJECTS_TABLE: 'p',
  FINISHES_TABLE: 'f',
  SERVICES_TABLE: 'sv',
  SETTINGS_TABLE: 'st',
  PUBLICATIONS_TABLE: 'pub',
  AUDIT_TABLE: 'a',
  AUDIT_SCOPE_INDEX: 'idx',
  PUBLISH_BUCKET: 'b',
};

describe('loadConfig (admin-publish)', () => {
  it('lee todas las variables; la distribución es opcional', () => {
    const c = loadConfig(env);
    expect(c.bucket).toBe('b');
    expect(c.tables.publications).toBe('pub');
    expect(c.tables.auditScopeIndex).toBe('idx');
    expect(c.siteDistributionId).toBeUndefined();
    expect(loadConfig({ ...env, SITE_DISTRIBUTION_ID: 'E123' }).siteDistributionId).toBe('E123');
    expect(loadConfig({ ...env, SITE_DISTRIBUTION_ID: '' }).siteDistributionId).toBeUndefined();
  });

  it.each(Object.keys(env))('falla con un error claro si falta %s', (name) => {
    const resto: Record<string, string> = { ...env };
    delete resto[name];
    expect(() => loadConfig(resto)).toThrow(name);
  });
});

describe('loadConfig (admin-publish): reconstrucción del sitio', () => {
  const completa = {
    ...env,
    SITE_REBUILD_TOKEN_PARAM: '/canteras/dev/github-dispatch-token',
    SITE_REBUILD_REPOSITORY: 'mi-dueno/mi-repo',
    SITE_REBUILD_WORKFLOW: 'site-build.yml',
    SITE_REBUILD_REF: 'main',
  };

  it('sin variables: sin reconstrucción', () => {
    expect(loadConfig(env).siteRebuild).toBeUndefined();
  });

  it('con las cuatro variables: configuración completa', () => {
    expect(loadConfig(completa).siteRebuild).toEqual({
      tokenParam: '/canteras/dev/github-dispatch-token',
      repository: 'mi-dueno/mi-repo',
      workflowFile: 'site-build.yml',
      ref: 'main',
    });
  });

  it.each([
    'SITE_REBUILD_TOKEN_PARAM',
    'SITE_REBUILD_REPOSITORY',
    'SITE_REBUILD_WORKFLOW',
    'SITE_REBUILD_REF',
  ])('si falta %s (valores parciales) no hay reconstrucción', (name) => {
    const parcial: Record<string, string> = { ...completa };
    delete parcial[name];
    expect(loadConfig(parcial).siteRebuild).toBeUndefined();
    expect(loadConfig({ ...completa, [name]: '' }).siteRebuild).toBeUndefined();
  });

  it.each([
    ['SITE_REBUILD_REPOSITORY', 'sin-barra'],
    ['SITE_REBUILD_REPOSITORY', 'a/b/c'],
    ['SITE_REBUILD_WORKFLOW', '../x.yml'],
    ['SITE_REBUILD_WORKFLOW', 'site-build.sh'],
    ['SITE_REBUILD_REF', 'main; rm'],
  ])('un %s mal formado (%s) desactiva la reconstrucción en vez de usarlo', (name, valor) => {
    expect(loadConfig({ ...completa, [name]: valor }).siteRebuild).toBeUndefined();
  });
});

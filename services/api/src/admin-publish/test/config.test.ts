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

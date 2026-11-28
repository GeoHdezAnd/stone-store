import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

// Sintetiza `bin/app.ts` completo (el cableado real entre stacks) y revisa el manifiesto de
// ensamblado: dependencias entre stacks y ausencia de ciclos.

interface Manifest {
  artifacts: Record<string, { type: string; dependencies?: string[] }>;
}

const SITE_ID = 'E1ABCDEF234567';

async function synthApp(env: Record<string, string>): Promise<{
  stacks: Record<string, string[]>;
  outdir: string;
}> {
  const outdir = mkdtempSync(join(tmpdir(), 'canteras-app-'));
  vi.resetModules();
  vi.stubEnv('CDK_OUTDIR', outdir);
  // Sin red ni empaquetado de esbuild/sharp al sintetizar.
  vi.stubEnv(
    'CDK_CONTEXT_JSON',
    JSON.stringify({ skipSharpCheck: true, 'aws:cdk:bundling-stacks': [] }),
  );
  vi.stubEnv('ALERT_EMAIL', 'alertas@ejemplo.mx');
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  await import('../app.js');
  const manifest = JSON.parse(readFileSync(join(outdir, 'manifest.json'), 'utf8')) as Manifest;
  const stacks: Record<string, string[]> = {};
  for (const [id, a] of Object.entries(manifest.artifacts)) {
    if (a.type === 'aws:cloudformation:stack') {
      stacks[id] = (a.dependencies ?? []).filter((d) => !d.endsWith('.assets'));
    }
  }
  return { stacks, outdir };
}

const baseEnv = {
  APP_ENV: 'dev',
  SITE_DISTRIBUTION_ID: SITE_ID,
  ADMIN_ORIGINS: 'https://d111111abcdef8.cloudfront.net',
  SITE_ORIGINS: 'https://d222222abcdef8.cloudfront.net',
  AWS_ENDPOINT_URL: '',
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('bin/app.ts: orden de despliegue y ciclos', () => {
  it('sintetiza con el id de la distribución sin DependencyCycle', async () => {
    const { stacks } = await synthApp(baseEnv);
    expect(Object.keys(stacks).sort()).toEqual(
      [
        'canteras-admin-site-dev',
        'canteras-api-dev',
        'canteras-auth-dev',
        'canteras-ci-dev',
        'canteras-data-dev',
        'canteras-media-dev',
        'canteras-observability-dev',
        'canteras-publish-dev',
        'canteras-site-dev',
      ].sort(),
    );
  });

  it('site, admin-site, data y auth no dependen de ningún otro stack (paso A)', async () => {
    const { stacks } = await synthApp(baseEnv);
    for (const id of ['site', 'admin-site', 'data', 'auth']) {
      expect(stacks[`canteras-${id}-dev`], id).toEqual([]);
    }
  });

  it('media y publish tampoco dependen de site (solo comparten el id por variable de entorno)', async () => {
    const { stacks } = await synthApp(baseEnv);
    expect(stacks['canteras-media-dev']).not.toContain('canteras-site-dev');
    expect(stacks['canteras-publish-dev']).not.toContain('canteras-site-dev');
    expect(stacks['canteras-site-dev']).not.toContain('canteras-media-dev');
    expect(stacks['canteras-site-dev']).not.toContain('canteras-publish-dev');
  });

  it('api depende de media y publish; observability depende de api y media; nadie depende de site', async () => {
    const { stacks } = await synthApp(baseEnv);
    expect(stacks['canteras-api-dev']).toEqual(
      expect.arrayContaining(['canteras-media-dev', 'canteras-publish-dev']),
    );
    expect(stacks['canteras-observability-dev']).toEqual(
      expect.arrayContaining(['canteras-api-dev', 'canteras-media-dev']),
    );
    for (const [id, deps] of Object.entries(stacks)) {
      expect(deps, id).not.toContain('canteras-site-dev');
    }
  });

  it('la plantilla de site no tiene Fn::ImportValue', async () => {
    const { outdir } = await synthApp(baseEnv);
    const file = readdirSync(outdir).find((f) => f === 'canteras-site-dev.template.json')!;
    expect(readFileSync(join(outdir, file), 'utf8')).not.toContain('Fn::ImportValue');
  });

  it('sin SITE_DISTRIBUTION_ID también sintetiza (media y publish quedan sin permiso de CloudFront)', async () => {
    const { stacks, outdir } = await synthApp({ ...baseEnv, SITE_DISTRIBUTION_ID: '' });
    expect(stacks['canteras-site-dev']).toEqual([]);
    for (const f of ['canteras-media-dev', 'canteras-publish-dev']) {
      expect(readFileSync(join(outdir, `${f}.template.json`), 'utf8')).not.toContain(
        'cloudfront.amazonaws.com',
      );
    }
  });

  it('con el id, media y publish SÍ llevan el permiso de CloudFront con ese id exacto', async () => {
    const { outdir } = await synthApp(baseEnv);
    for (const f of ['canteras-media-dev', 'canteras-publish-dev']) {
      const text = readFileSync(join(outdir, `${f}.template.json`), 'utf8');
      expect(text).toContain(`distribution/${SITE_ID}`);
    }
  });

  it('un SITE_DISTRIBUTION_ID inválido hace fallar la síntesis', async () => {
    await expect(synthApp({ ...baseEnv, SITE_DISTRIBUTION_ID: 'no-valido' })).rejects.toThrow(
      /SITE_DISTRIBUTION_ID/,
    );
  });
});

describe('bin/app.ts: reconstrucción del sitio al publicar', () => {
  const PARAM = '/canteras/dev/github-dispatch-token';
  const plantilla = (outdir: string, stack: string): string =>
    readFileSync(join(outdir, `${stack}.template.json`), 'utf8');

  it('con SITE_REBUILD_TOKEN_PARAM: la API recibe parámetro, repo derivado, workflow y rama por defecto', async () => {
    const { outdir } = await synthApp({ ...baseEnv, SITE_REBUILD_TOKEN_PARAM: PARAM });
    const api = plantilla(outdir, 'canteras-api-dev');
    expect(api).toContain(`"SITE_REBUILD_TOKEN_PARAM": "${PARAM}"`);
    expect(api).toMatch(/"SITE_REBUILD_REPOSITORY": "[A-Za-z0-9-]+\/stone-store"/);
    expect(api).toContain('"SITE_REBUILD_WORKFLOW": "site-build.yml"');
    expect(api).toContain('"SITE_REBUILD_REF": "main"');
    expect(api).toContain('ssm:GetParameter');
  });

  it('el repositorio es el MISMO que confía el rol de CI (se deriva, no se duplica)', async () => {
    const { outdir } = await synthApp({ ...baseEnv, SITE_REBUILD_TOKEN_PARAM: PARAM });
    const repo = /"SITE_REBUILD_REPOSITORY": "([^"]+)"/.exec(
      plantilla(outdir, 'canteras-api-dev'),
    )![1]!;
    const [owner, name] = repo.split('/');
    expect(plantilla(outdir, 'canteras-ci-dev')).toContain(`repo:${owner}@`);
    expect(plantilla(outdir, 'canteras-ci-dev')).toContain(`/${name}@`);
  });

  it('SITE_REBUILD_WORKFLOW y SITE_REBUILD_REF se pueden cambiar', async () => {
    const { outdir } = await synthApp({
      ...baseEnv,
      SITE_REBUILD_TOKEN_PARAM: PARAM,
      SITE_REBUILD_WORKFLOW: 'otro.yml',
      SITE_REBUILD_REF: 'release/dev',
    });
    const api = plantilla(outdir, 'canteras-api-dev');
    expect(api).toContain('"SITE_REBUILD_WORKFLOW": "otro.yml"');
    expect(api).toContain('"SITE_REBUILD_REF": "release/dev"');
  });

  it('sin SITE_REBUILD_TOKEN_PARAM la API no recibe variables ni SSM de reconstrucción', async () => {
    const { outdir } = await synthApp(baseEnv);
    const api = plantilla(outdir, 'canteras-api-dev');
    expect(api).not.toContain('SITE_REBUILD_');
    expect(api).not.toContain('github-dispatch-token');
  });

  it('un SITE_REBUILD_TOKEN_PARAM inválido hace fallar la síntesis', async () => {
    await expect(synthApp({ ...baseEnv, SITE_REBUILD_TOKEN_PARAM: '/canteras/*' })).rejects.toThrow(
      /SITE_REBUILD_TOKEN_PARAM/,
    );
  });

  it('con el id de la distribución, CI crea SiteRebuildRole acotado a ESA distribución, sin dependencias', async () => {
    const { stacks, outdir } = await synthApp(baseEnv);
    const ci = plantilla(outdir, 'canteras-ci-dev');
    expect(ci).toContain('SiteRebuildRole');
    expect(ci).toContain(`distribution/${SITE_ID}`);
    expect(stacks['canteras-ci-dev']).toEqual([]);
  });

  it('sin el id de la distribución, CI NO crea SiteRebuildRole', async () => {
    const { outdir } = await synthApp({ ...baseEnv, SITE_DISTRIBUTION_ID: '' });
    expect(plantilla(outdir, 'canteras-ci-dev')).not.toContain('SiteRebuildRole');
  });
});

describe('bin/app.ts: la reconstrucción falla cerrado', () => {
  const PARAM = '/canteras/dev/github-dispatch-token';

  it('prod con SITE_REBUILD_TOKEN_PARAM lanza (el workflow solo existe para dev)', async () => {
    await expect(
      synthApp({
        ...baseEnv,
        APP_ENV: 'prod',
        CDK_DEFAULT_ACCOUNT: '123456789012',
        SITE_REBUILD_TOKEN_PARAM: PARAM,
      }),
    ).rejects.toThrow(/solo está definida para dev/);
  });

  it('dev con SITE_REBUILD_TOKEN_PARAM pero sin SITE_DISTRIBUTION_ID lanza', async () => {
    await expect(
      synthApp({ ...baseEnv, SITE_DISTRIBUTION_ID: '', SITE_REBUILD_TOKEN_PARAM: PARAM }),
    ).rejects.toThrow(/SITE_DISTRIBUTION_ID/);
  });
});

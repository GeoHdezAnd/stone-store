import { describe, expect, it } from 'vitest';

import {
  buildSyncCommands,
  IMMUTABLE,
  NO_CACHE,
  parseSyncArgs,
  targetConfig,
} from './sync-site-lib';

describe('targetConfig', () => {
  it('site: stack, directorio y prefijo de Astro', () => {
    expect(targetConfig('site', 'dev')).toMatchObject({
      stackName: 'canteras-site-dev',
      defaultDir: 'infra/placeholder',
      assetPrefix: '_astro/',
    });
  });

  it('admin: stack, directorio y prefijo de Vite; exige config.json y excluye el ejemplo', () => {
    const config = targetConfig('admin', 'prod');
    expect(config).toMatchObject({
      stackName: 'canteras-admin-site-prod',
      defaultDir: 'apps/admin/dist',
      assetPrefix: 'assets/',
    });
    expect(config.required).toContain('config.json');
    expect(config.excluded).toContain('config.example.json');
  });
});

describe('parseSyncArgs', () => {
  it('por defecto: site, dev, sin directorio (compatibilidad con el uso anterior)', () => {
    expect(parseSyncArgs([], {})).toEqual({ target: 'site', appEnv: 'dev', dir: undefined });
    expect(parseSyncArgs(['dist'], {}).dir).toBe('dist');
  });

  it('elige el destino por argumento o por variable', () => {
    expect(parseSyncArgs(['--target', 'admin'], {}).target).toBe('admin');
    expect(parseSyncArgs(['--target=admin', 'x'], {})).toMatchObject({ target: 'admin', dir: 'x' });
    expect(parseSyncArgs([], { SYNC_TARGET: 'admin' }).target).toBe('admin');
    expect(parseSyncArgs(['--target', 'site'], { SYNC_TARGET: 'admin' }).target).toBe('site');
  });

  it('rechaza destino, entorno y argumentos inválidos', () => {
    expect(() => parseSyncArgs(['--target', 'otro'], {})).toThrow(/Destino inválido/);
    expect(() => parseSyncArgs([], { APP_ENV: 'qa' })).toThrow(/APP_ENV/);
    expect(() => parseSyncArgs(['a', 'b'], {})).toThrow(/Uso/);
    expect(() => parseSyncArgs(['--x'], {})).toThrow(/Uso/);
    expect(() => parseSyncArgs(['--target'], {})).toThrow(/Uso/);
  });

  it('conserva la salvaguarda: prod nunca con emulador', () => {
    expect(() =>
      parseSyncArgs([], { APP_ENV: 'prod', AWS_ENDPOINT_URL: 'http://localhost:4566' }),
    ).toThrow(/prod/);
  });
});

describe('buildSyncCommands', () => {
  const make = (target: 'site' | 'admin') =>
    buildSyncCommands({
      dir: '/d',
      bucket: 'b',
      distributionId: 'E1',
      config: targetConfig(target, 'dev'),
    });

  it('assets con hash inmutables y el resto no-cache (admin)', () => {
    const [assets, rest, invalidation] = make('admin');
    expect(assets).toEqual(
      expect.arrayContaining(['--include', 'assets/*', '--cache-control', IMMUTABLE]),
    );
    expect(rest).toEqual(
      expect.arrayContaining(['--exclude', 'assets/*', '--cache-control', NO_CACHE, '--delete']),
    );
    expect(invalidation).toEqual([
      'cloudfront',
      'create-invalidation',
      '--distribution-id',
      'E1',
      '--paths',
      '/*',
    ]);
  });

  it('site usa _astro/ como prefijo inmutable', () => {
    const [assets] = make('site');
    expect(assets).toContain('_astro/*');
  });

  it('config.json e index.html nunca reciben immutable', () => {
    for (const target of ['site', 'admin'] as const) {
      const [assets] = make(target);
      const includes = (assets ?? []).filter((_, i, a) => a[i - 1] === '--include');
      expect(includes).toHaveLength(1);
      for (const name of ['config.json', 'index.html']) {
        expect(name.startsWith(includes[0]?.replace('*', '') ?? '?')).toBe(false);
      }
    }
  });

  it('admin excluye config.example.json en ambos syncs; site no excluye nada extra', () => {
    const [assets, rest] = make('admin');
    expect(assets).toEqual(expect.arrayContaining(['--exclude', 'config.example.json']));
    expect(rest).toEqual(expect.arrayContaining(['--exclude', 'config.example.json']));
    expect(make('site')[1]).not.toContain('config.example.json');
  });

  it('solo el segundo comando usa --delete', () => {
    const [assets, rest] = make('admin');
    expect(assets).not.toContain('--delete');
    expect(rest).toContain('--delete');
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  adminConfigSchema,
  buildAdminConfig,
  parseAdminConfigArgs,
  serializeAdminConfig,
  validateAdminConfig,
} from '../admin-config-lib';

const authOutputs = { UserPoolId: 'us-east-1_abc', UserPoolClientId: 'cli123' };
const base = {
  region: 'us-east-1',
  authOutputs,
  authStack: 'canteras-auth-dev',
  apiStack: 'canteras-api-dev',
};

describe('buildAdminConfig', () => {
  it('Floci: ruta local por el proxy de Vite y cognitoEndpoint relativo', () => {
    const config = buildAdminConfig({
      ...base,
      emulated: true,
      apiOutputs: { HttpApiId: '60afa9bcca', ApiUrl: 'http://ignorada' },
    });
    expect(config).toEqual({
      apiUrl: 'http://localhost:5173/_aws/execute-api/60afa9bcca/$default',
      userPoolId: 'us-east-1_abc',
      userPoolClientId: 'cli123',
      region: 'us-east-1',
      cognitoEndpoint: '/cognito/',
    });
  });

  it('AWS real: ApiUrl sin barra final y sin cognitoEndpoint', () => {
    const config = buildAdminConfig({
      ...base,
      emulated: false,
      apiOutputs: { ApiUrl: 'https://abc.execute-api.us-east-1.amazonaws.com/' },
    });
    expect(config.apiUrl).toBe('https://abc.execute-api.us-east-1.amazonaws.com');
    expect(config).not.toHaveProperty('cognitoEndpoint');
  });

  it('AWS real: rechaza una ApiUrl http que no sea localhost', () => {
    expect(() =>
      buildAdminConfig({ ...base, emulated: false, apiOutputs: { ApiUrl: 'http://x.mx' } }),
    ).toThrow(/https/);
  });

  it('falla con mensaje claro si falta una salida', () => {
    expect(() => buildAdminConfig({ ...base, emulated: true, apiOutputs: {} })).toThrow(
      /HttpApiId/,
    );
    expect(() =>
      buildAdminConfig({
        ...base,
        authOutputs: { UserPoolId: 'x' },
        emulated: false,
        apiOutputs: { ApiUrl: 'https://a.mx' },
      }),
    ).toThrow(/UserPoolClientId/);
  });
});

describe('validateAdminConfig', () => {
  const ok = {
    apiUrl: 'https://a.mx',
    userPoolId: 'p',
    userPoolClientId: 'c',
    region: 'us-east-1',
  };

  it('acepta http solo en localhost y 127.0.0.1', () => {
    expect(() => validateAdminConfig({ ...ok, apiUrl: 'http://localhost:5173/x' })).not.toThrow();
    expect(() => validateAdminConfig({ ...ok, apiUrl: 'http://127.0.0.1:4566/x' })).not.toThrow();
    expect(() => validateAdminConfig({ ...ok, apiUrl: 'http://api.mx' })).toThrow();
    expect(() => validateAdminConfig({ ...ok, apiUrl: 'http://localhost.evil.mx' })).toThrow();
  });

  it('rechaza claves de más y valores vacíos', () => {
    expect(() => validateAdminConfig({ ...ok, extra: 1 })).toThrow();
    expect(() => validateAdminConfig({ ...ok, userPoolId: '' })).toThrow();
  });

  it('serializa con salto de línea final', () => {
    expect(serializeAdminConfig(validateAdminConfig(ok)).endsWith('}\n')).toBe(true);
  });
});

describe('paridad con el frontend', () => {
  const root = resolve(import.meta.dirname, '..', '..');

  it('tiene las mismas claves que apps/admin/src/config.ts', () => {
    const source = readFileSync(resolve(root, 'apps/admin/src/config.ts'), 'utf8');
    const block = /z\.strictObject\(\{([\s\S]*?)\}\)/.exec(source)?.[1] ?? '';
    const frontendKeys = [...block.matchAll(/^\s*(\w+)\s*[:,]/gm)].map((m) => m[1]).sort();
    expect(frontendKeys.length).toBeGreaterThan(0);
    expect(Object.keys(adminConfigSchema.shape).sort()).toEqual(frontendKeys);
  });

  it('config.example.json cumple el schema', () => {
    const raw: unknown = JSON.parse(
      readFileSync(resolve(root, 'apps/admin/public/config.example.json'), 'utf8'),
    );
    expect(() => validateAdminConfig(raw)).not.toThrow();
  });
});

describe('parseAdminConfigArgs', () => {
  it('por defecto: dev, apps/admin/public, sin emulador', () => {
    const args = parseAdminConfigArgs([], {});
    expect(args).toMatchObject({
      appEnv: 'dev',
      emulated: false,
      outDir: 'apps/admin/public',
      region: 'us-east-1',
    });
  });

  it('acepta --out y rechaza argumentos desconocidos', () => {
    expect(parseAdminConfigArgs(['--out', 'apps/admin/dist'], {}).outDir).toBe('apps/admin/dist');
    expect(() => parseAdminConfigArgs(['--out'], {})).toThrow(/Uso/);
    expect(() => parseAdminConfigArgs(['dist'], {})).toThrow(/Uso/);
  });

  it('prod con emulador falla; APP_ENV inválido falla', () => {
    expect(() =>
      parseAdminConfigArgs([], { APP_ENV: 'prod', AWS_ENDPOINT_URL: 'http://localhost:4566' }),
    ).toThrow(/prod/);
    expect(() => parseAdminConfigArgs([], { APP_ENV: 'qa' })).toThrow(/inválido/);
  });

  it('con emulador exige endpoint local y llaves test', () => {
    expect(() =>
      parseAdminConfigArgs([], { AWS_ENDPOINT_URL: 'http://evil.mx', AWS_ACCESS_KEY_ID: 'test' }),
    ).toThrow();
    const args = parseAdminConfigArgs([], {
      AWS_ENDPOINT_URL: 'http://localhost:4566',
      AWS_ACCESS_KEY_ID: 'test',
    });
    expect(args.emulated).toBe(true);
    expect(args.endpoint).toBe('http://localhost:4566');
  });
});

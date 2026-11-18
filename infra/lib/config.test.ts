import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FLOCI_ACCOUNT, FLOCI_API_PORT, FLOCI_IP, resolveEnv } from './config';

const REAL = '123456789012';
const FLOCI = { AWS_ENDPOINT_URL: 'http://localhost:4566' };

describe('resolveEnv', () => {
  describe('APP_ENV', () => {
    it('usa dev en us-east-1 sin cuenta cuando no hay variables', () => {
      expect(resolveEnv({})).toEqual({
        name: 'dev',
        account: undefined,
        region: 'us-east-1',
        emulated: false,
      });
    });

    it('marca emulated cuando hay AWS_ENDPOINT_URL (Floci)', () => {
      expect(resolveEnv(FLOCI).emulated).toBe(true);
    });

    it('acepta dev explícito', () => {
      expect(resolveEnv({ APP_ENV: 'dev' }).name).toBe('dev');
    });

    it('acepta prod con cuenta explícita', () => {
      const r = resolveEnv({ APP_ENV: 'prod', CDK_DEFAULT_ACCOUNT: REAL });
      expect(r.name).toBe('prod');
      expect(r.account).toBe(REAL);
    });

    it.each(['Prod', 'production', 'staging', ''])('rechaza APP_ENV inválido "%s"', (v) => {
      expect(() => resolveEnv({ APP_ENV: v })).toThrow(/APP_ENV inválido/);
    });
  });

  describe('región', () => {
    it('prefiere CDK_DEFAULT_REGION sobre las demás (caso realista del CLI)', () => {
      const r = resolveEnv({
        CDK_DEFAULT_REGION: 'eu-west-1',
        AWS_REGION: 'us-west-2',
        AWS_DEFAULT_REGION: 'sa-east-1',
      });
      expect(r.region).toBe('eu-west-1');
    });

    it('prefiere AWS_REGION sobre AWS_DEFAULT_REGION', () => {
      expect(resolveEnv({ AWS_REGION: 'us-west-2', AWS_DEFAULT_REGION: 'sa-east-1' }).region).toBe(
        'us-west-2',
      );
    });

    it('usa AWS_DEFAULT_REGION cuando es la única', () => {
      expect(resolveEnv({ AWS_DEFAULT_REGION: 'sa-east-1' }).region).toBe('sa-east-1');
    });
  });

  describe('cuenta y guardas de Floci', () => {
    it('toma CDK_DEFAULT_ACCOUNT antes que AWS_ACCOUNT_ID', () => {
      expect(
        resolveEnv({ CDK_DEFAULT_ACCOUNT: REAL, AWS_ACCOUNT_ID: '111111111111' }).account,
      ).toBe(REAL);
    });

    it('toma AWS_ACCOUNT_ID si no hay CDK_DEFAULT_ACCOUNT', () => {
      expect(resolveEnv({ AWS_ACCOUNT_ID: REAL }).account).toBe(REAL);
    });

    it('con emulador y sin cuenta usa la cuenta de Floci', () => {
      expect(resolveEnv(FLOCI).account).toBe(FLOCI_ACCOUNT);
    });

    it('con emulador acepta la cuenta de Floci explícita', () => {
      expect(resolveEnv({ ...FLOCI, CDK_DEFAULT_ACCOUNT: FLOCI_ACCOUNT }).account).toBe(
        FLOCI_ACCOUNT,
      );
    });

    it('con emulador rechaza cualquier otra cuenta', () => {
      expect(() => resolveEnv({ ...FLOCI, CDK_DEFAULT_ACCOUNT: REAL })).toThrow(/Floci/);
    });

    it('rechaza la cuenta de Floci si no hay AWS_ENDPOINT_URL', () => {
      expect(() => resolveEnv({ CDK_DEFAULT_ACCOUNT: FLOCI_ACCOUNT })).toThrow(/solo de Floci/);
    });
  });

  describe('prod', () => {
    it('exige cuenta explícita', () => {
      expect(() => resolveEnv({ APP_ENV: 'prod' })).toThrow(/cuenta explícita/);
    });

    it('rechaza AWS_ENDPOINT_URL', () => {
      expect(() => resolveEnv({ APP_ENV: 'prod', CDK_DEFAULT_ACCOUNT: REAL, ...FLOCI })).toThrow(
        /AWS_ENDPOINT_URL/,
      );
    });

    it('rechaza prod con la cuenta de Floci', () => {
      expect(() => resolveEnv({ APP_ENV: 'prod', CDK_DEFAULT_ACCOUNT: FLOCI_ACCOUNT })).toThrow();
    });

    it('con CDK_DEFAULT_REGION devuelve el entorno completo', () => {
      expect(
        resolveEnv({ APP_ENV: 'prod', CDK_DEFAULT_ACCOUNT: REAL, CDK_DEFAULT_REGION: 'us-east-2' }),
      ).toEqual({ name: 'prod', account: REAL, region: 'us-east-2', emulated: false });
    });
  });
});

describe('constantes de Floci', () => {
  it('la IP fija y el puerto coinciden con docker-compose.yml', () => {
    expect(FLOCI_IP).toBe('172.30.0.10');
    expect(FLOCI_API_PORT).toBe(4566);
    const compose = readFileSync(
      join(import.meta.dirname, '..', '..', 'docker-compose.yml'),
      'utf8',
    );
    expect(compose).toContain(`ipv4_address: ${FLOCI_IP}`);
    expect(compose).toContain(`FLOCI_HOSTNAME: ${FLOCI_IP}`);
    expect(compose).toContain(`'${FLOCI_API_PORT}:${FLOCI_API_PORT}'`);
  });
});

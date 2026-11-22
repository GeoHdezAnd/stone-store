import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ACTIVE_KEY } from '../../services/api/src/admin-freight/repository';
import {
  buildFreightSeed,
  checkSeedEnv,
  FreightSeedValidationError,
  readFreightContent,
  SEED_VERSION,
} from '../seed-freight-lib';

const CONTENT = join(import.meta.dirname, '..', '..', 'content');
const real = (): Record<string, unknown> =>
  structuredClone(readFreightContent(CONTENT)) as Record<string, unknown>;
const AT = '2026-11-19T15:00:00.000Z';

describe('buildFreightSeed', () => {
  it('arma la versión t0001 y el puntero ACTIVE que apunta a ella', () => {
    const { row, pointer } = buildFreightSeed(real(), AT);
    expect(SEED_VERSION).toBe('t0001');
    expect(row['version']).toBe('t0001');
    expect(pointer).toEqual({
      version: ACTIVE_KEY,
      activeVersion: 't0001',
      latestVersion: 't0001',
      activadaPor: 'seed',
      activadaAt: AT,
    });
  });

  it('la fila queda marcada como ejemplo, sin `activa` (se deriva del puntero)', () => {
    const { row } = buildFreightSeed(real(), AT);
    expect(row['ejemplo']).toBe(true);
    expect(row).not.toHaveProperty('activa');
    expect(row['creadaPor']).toBe('seed');
    expect(row['creadaAt']).toBe(AT);
  });

  it('ignora la versión del archivo: siempre t0001', () => {
    const raw = real();
    raw['version'] = 'v1';
    expect(buildFreightSeed(raw, AT).row['version']).toBe('t0001');
  });

  it('rechaza una configuración que no cumple el esquema', () => {
    const raw = real();
    raw['camiones'] = [];
    expect(() => buildFreightSeed(raw, AT)).toThrow(FreightSeedValidationError);
  });

  it('rechaza si no está marcada como ejemplo (el seed solo carga datos de ejemplo)', () => {
    const raw = real();
    raw['ejemplo'] = false;
    expect(() => buildFreightSeed(raw, AT)).toThrow(/ejemplo/);
    delete raw['ejemplo'];
    expect(() => buildFreightSeed(raw, AT)).toThrow(/ejemplo/);
  });

  it('rechaza contenido que no es un objeto', () => {
    for (const raw of [null, [], 'x', 3]) {
      expect(() => buildFreightSeed(raw, AT)).toThrow(FreightSeedValidationError);
    }
  });

  it('el mensaje de error no depende de datos sensibles y lista los campos', () => {
    const raw = real();
    raw['maxKm'] = -1;
    try {
      buildFreightSeed(raw, AT);
      throw new Error('se esperaba un error');
    } catch (e) {
      expect((e as Error).message).toContain('maxKm');
    }
  });
});

describe('checkSeedEnv (mismas salvaguardas que seed.ts)', () => {
  it('dev es el valor por defecto', () => {
    expect(checkSeedEnv({})).toBe('dev');
    expect(checkSeedEnv({ APP_ENV: 'dev', AWS_ENDPOINT_URL: 'http://localhost:4566' })).toBe('dev');
  });

  it('APP_ENV inválido: error', () => {
    expect(() => checkSeedEnv({ APP_ENV: 'staging' })).toThrow(/APP_ENV inválido/);
  });

  it('prod con emulador: error', () => {
    expect(() =>
      checkSeedEnv({
        APP_ENV: 'prod',
        AWS_ENDPOINT_URL: 'http://localhost:4566',
        SEED_CONFIRM_PROD: 'si',
      }),
    ).toThrow(/emulador/);
  });

  it('prod sin confirmación: error; con ella, pasa', () => {
    expect(() => checkSeedEnv({ APP_ENV: 'prod' })).toThrow(/SEED_CONFIRM_PROD/);
    expect(checkSeedEnv({ APP_ENV: 'prod', SEED_CONFIRM_PROD: 'si' })).toBe('prod');
  });
});

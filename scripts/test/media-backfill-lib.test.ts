import { variantKey } from '@canteras/shared';
import { describe, expect, it } from 'vitest';

import { FakeProcessor, MAGIC, info } from '../../services/api/src/media-variants/test/fixtures';
import type { ObjectStore } from '../../services/api/src/media-variants/process-event';
import { ImageRejectedError } from '../../services/api/src/media-variants/processor';
import {
  checkBackfillEnv,
  formatBackfillReport,
  parseBackfillArgs,
  planBackfill,
  runBackfill,
  type StoredObject,
} from '../media-backfill-lib';

const UUID_A = '3f2b8c1e-9a4d-4e6b-8c7a-1d2e3f4a5b6c';
const UUID_B = '4a2b8c1e-9a4d-4e6b-8c7a-1d2e3f4a5b6d';
const A = `stones/arenisca/${UUID_A}.jpg`;
const B = `projects/casa/${UUID_B}.png`;
const WIDTHS = [480, 960, 1600] as const;
const variantsOf = (k: string) => WIDTHS.map((w) => variantKey(k, w));

class MemStore implements ObjectStore {
  public objects = new Map<string, Uint8Array>();
  public gets: string[] = [];
  public puts: string[] = [];
  public failPutFor: string | undefined;
  public get(_b: string, key: string): Promise<Uint8Array> {
    this.gets.push(key);
    const o = this.objects.get(key);
    return o ? Promise.resolve(o) : Promise.reject(new ImageRejectedError('not_found'));
  }
  public put(_b: string, key: string, body: Uint8Array): Promise<void> {
    if (this.failPutFor !== undefined && key.startsWith(this.failPutFor)) {
      return Promise.reject(new Error('SlowDown arn:aws:s3:::secreto'));
    }
    this.puts.push(key);
    this.objects.set(key, body);
    return Promise.resolve();
  }
  public list(): StoredObject[] {
    return [...this.objects].map(([key, body]) => ({ key, size: body.length }));
  }
}

const mk = (info_ = info('jpeg', 3000, 2000)) => ({
  store: new MemStore(),
  processor: new FakeProcessor(info_),
});

describe('checkBackfillEnv (no mezclar Floci con AWS real)', () => {
  it('dev sin emulador y dev con Floci (credenciales de prueba) pasan', () => {
    expect(checkBackfillEnv({})).toBe('dev');
    expect(
      checkBackfillEnv({
        AWS_ENDPOINT_URL: 'http://localhost:4566',
        AWS_ACCESS_KEY_ID: 'test',
        AWS_SECRET_ACCESS_KEY: 'test',
      }),
    ).toBe('dev');
  });

  it('prod exige confirmación y no admite emulador', () => {
    expect(() => checkBackfillEnv({ APP_ENV: 'prod' })).toThrow(/SEED_CONFIRM_PROD/);
    expect(() =>
      checkBackfillEnv({ APP_ENV: 'prod', SEED_CONFIRM_PROD: 'si', AWS_ENDPOINT_URL: 'http://x' }),
    ).toThrow(/AWS_ENDPOINT_URL/);
    expect(checkBackfillEnv({ APP_ENV: 'prod', SEED_CONFIRM_PROD: 'si' })).toBe('prod');
  });

  it('APP_ENV inválido lanza', () => {
    expect(() => checkBackfillEnv({ APP_ENV: 'staging' })).toThrow(/APP_ENV/);
  });

  it('con emulador NUNCA acepta credenciales reales (ni perfil de AWS)', () => {
    const base = { AWS_ENDPOINT_URL: 'http://localhost:4566' };
    expect(() => checkBackfillEnv({ ...base, AWS_ACCESS_KEY_ID: 'AKIAREAL' })).toThrow(
      /credenciales/,
    );
    expect(() => checkBackfillEnv({ ...base })).toThrow(/credenciales/);
    expect(() =>
      checkBackfillEnv({ ...base, AWS_ACCESS_KEY_ID: 'test', AWS_PROFILE: 'miperfil' }),
    ).toThrow(/AWS_PROFILE/);
  });
});

describe('parseBackfillArgs: dry-run por defecto', () => {
  it('sin argumentos = dry-run', () => {
    expect(parseBackfillArgs([])).toEqual({ apply: false });
    expect(parseBackfillArgs(['--dry-run'])).toEqual({ apply: false });
  });
  it('--apply es explícito', () => {
    expect(parseBackfillArgs(['--apply'])).toEqual({ apply: true });
  });
  it('--apply y --dry-run juntos, o argumentos desconocidos, lanzan', () => {
    expect(() => parseBackfillArgs(['--apply', '--dry-run'])).toThrow(/--apply/);
    expect(() => parseBackfillArgs(['--force'])).toThrow(/--force/);
  });
});

describe('planBackfill', () => {
  const objs = (...keys: string[]): StoredObject[] => keys.map((key) => ({ key, size: 1000 }));

  it('detecta originales sin las 3 variantes y omite los completos', () => {
    const plan = planBackfill(objs(A, ...variantsOf(A), B));
    expect(plan.pending.map((o) => o.key)).toEqual([B]);
    expect(plan.originals).toBe(2);
    expect(plan.complete).toBe(1);
  });

  it('un original con solo 2 de 3 variantes está pendiente', () => {
    expect(planBackfill(objs(A, ...variantsOf(A).slice(0, 2))).pending).toHaveLength(1);
  });

  it('ignora variantes, otros prefijos y claves que no son fotos', () => {
    const plan = planBackfill(
      objs(...variantsOf(A), 'published/catalog.json', `otros/a/${UUID_A}.jpg`),
    );
    expect(plan.originals).toBe(0);
    expect(plan.pending).toEqual([]);
  });

  it('conserva el tamaño declarado (para el tope previo a descargar)', () => {
    expect(planBackfill([{ key: A, size: 123 }]).pending[0]).toEqual({ key: A, size: 123 });
  });
});

describe('runBackfill', () => {
  it('dry-run: calcula el plan y NO descarga ni escribe nada', async () => {
    const { store, processor } = mk();
    store.objects.set(A, MAGIC.jpeg);
    const report = await runBackfill({ bucket: 'b', store, processor, apply: false }, store.list());
    expect(report.pending).toBe(1);
    expect(report.created).toBe(0);
    expect(store.gets).toEqual([]);
    expect(store.puts).toEqual([]);
    expect(processor.inspected).toBe(0);
  });

  it('--apply genera las 3 variantes de cada original pendiente', async () => {
    const { store, processor } = mk();
    store.objects.set(A, MAGIC.jpeg);
    const report = await runBackfill({ bucket: 'b', store, processor, apply: true }, store.list());
    expect(report).toMatchObject({ pending: 1, created: 1, rejected: 0, failed: 0 });
    expect(store.puts.sort()).toEqual(variantsOf(A).sort());
  });

  it('es idempotente: una segunda pasada ya no encuentra nada pendiente ni escribe', async () => {
    const { store, processor } = mk();
    store.objects.set(A, MAGIC.jpeg);
    await runBackfill({ bucket: 'b', store, processor, apply: true }, store.list());
    store.puts = [];
    const again = await runBackfill({ bucket: 'b', store, processor, apply: true }, store.list());
    expect(again).toMatchObject({ pending: 0, created: 0, complete: 1 });
    expect(store.puts).toEqual([]);
  });

  it('un original inválido cuenta como rechazado y no frena a los demás', async () => {
    const { store, processor } = mk();
    store.objects.set(A, MAGIC.svg); // tipo no permitido
    store.objects.set(B, MAGIC.png);
    processor.info = info('png', 2000, 1000);
    const report = await runBackfill({ bucket: 'b', store, processor, apply: true }, store.list());
    expect(report).toMatchObject({ pending: 2, created: 1, rejected: 1, failed: 0 });
  });

  it('un fallo transitorio cuenta como fallido y no frena a los demás', async () => {
    const { store, processor } = mk();
    store.objects.set(A, MAGIC.jpeg);
    store.objects.set(B, MAGIC.png);
    processor.info = info('jpeg', 2000, 1000);
    store.failPutFor = 'stones/';
    const report = await runBackfill({ bucket: 'b', store, processor, apply: true }, store.list());
    expect(report.failed).toBe(1);
    expect(store.puts.some((k) => k.startsWith('projects/'))).toBe(false); // png no coincide con info jpeg
  });
});

describe('formatBackfillReport: mensajes en español y sin PII', () => {
  it('no incluye claves completas ni UUID, solo cifras y pistas parciales', async () => {
    const { store, processor } = mk();
    store.objects.set(A, MAGIC.jpeg);
    store.failPutFor = 'stones/';
    const report = await runBackfill({ bucket: 'b', store, processor, apply: true }, store.list());
    const text = formatBackfillReport(report, true);
    expect(text).toMatch(/aplicado/i);
    expect(text).not.toContain(A);
    expect(text).not.toContain(UUID_A);
    expect(text).not.toContain('secreto');
    expect(text).toContain('stones');
  });

  it('en dry-run indica que no se escribió nada y cómo aplicar', () => {
    const text = formatBackfillReport(
      {
        originals: 3,
        complete: 1,
        pending: 2,
        created: 0,
        rejected: 0,
        failed: 0,
        hints: ['stones/…5b6c.jpg'],
      },
      false,
    );
    expect(text).toMatch(/simulaci[oó]n/i);
    expect(text).toContain('--apply');
  });
});

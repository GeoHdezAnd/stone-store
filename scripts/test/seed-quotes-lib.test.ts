import { join } from 'node:path';
import {
  canTransition,
  computeFinalQuote,
  quoteSchema,
  stripStorageKeys,
  isUlid,
  type Quote,
} from '../../packages/shared/src/index';
import { describe, expect, it } from 'vitest';

import {
  buildQuoteSeeds,
  checkQuotesSeedEnv,
  checkSeedEnv,
  folioCounterName,
  loadSeedInputs,
  SEED_QUOTE_COUNT,
  seedYearCounts,
} from '../seed-quotes-lib';

const CONTENT = join(import.meta.dirname, '..', '..', 'content');
const NOW = new Date('2026-11-19T15:00:00.000Z');
const inputs = loadSeedInputs(CONTENT, NOW.toISOString());

function build(now = NOW, start?: Record<string, number>) {
  const counts = seedYearCounts(now);
  const folioStart = start ?? Object.fromEntries(Object.keys(counts).map((y) => [y, 1]));
  return buildQuoteSeeds({ now, ...inputs, folioStart });
}
const domain = (row: Record<string, unknown>): Quote => quoteSchema.parse(stripStorageKeys(row));

describe('buildQuoteSeeds', () => {
  const rows = build();

  it('genera 30 solicitudes válidas según quoteSchema', () => {
    expect(SEED_QUOTE_COUNT).toBe(30);
    expect(rows).toHaveLength(30);
    for (const r of rows) expect(() => domain(r)).not.toThrow();
  });

  it('todas son de ejemplo, con correos @example.com y teléfonos 555-01xx', () => {
    for (const r of rows) {
      const q = domain(r);
      expect(q.ejemplo).toBe(true);
      expect(q.customer.correo).toMatch(/@example\.com$/);
      expect(q.customer.telefono).toMatch(/^555-01\d\d$/);
    }
  });

  it('ids ULID únicos y folios únicos y consecutivos CN-AAAA-NNNNN en orden cronológico', () => {
    const qs = rows.map(domain);
    expect(new Set(qs.map((q) => q.quoteId)).size).toBe(30);
    for (const q of qs) expect(isUlid(q.quoteId)).toBe(true);
    const sorted = [...qs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    expect(sorted.map((q) => q.folio)).toEqual(
      Array.from({ length: 30 }, (_, i) => `CN-2026-${String(i + 1).padStart(5, '0')}`),
    );
  });

  it('los folios arrancan donde indica el contador', () => {
    const qs = build(NOW, { '2026': 101 }).map(domain);
    expect(qs.map((q) => q.folio).sort()[0]).toBe('CN-2026-00101');
  });

  it('cruzando de año usa un contador por año', () => {
    const now = new Date('2027-01-05T10:00:00.000Z');
    const counts = seedYearCounts(now);
    expect(Object.keys(counts).sort()).toEqual(['2026', '2027']);
    expect(counts['2026']! + counts['2027']!).toBe(30);
    const qs = build(now, { '2026': 7, '2027': 1 }).map(domain);
    for (const q of qs) expect(q.folio.slice(3, 7)).toBe(q.createdAt.slice(0, 4));
    expect(
      qs
        .filter((q) => q.folio.startsWith('CN-2027'))
        .map((q) => q.folio)
        .sort()[0],
    ).toBe('CN-2027-00001');
    expect(folioCounterName(2027)).toBe('folio#2027');
  });

  it('hay variedad de estados y cada historial es una cadena de transiciones válidas', () => {
    const qs = rows.map(domain);
    const estados = new Set(qs.map((q) => q.status));
    expect([...estados].sort()).toEqual([
      'cancelada',
      'cotizada',
      'en_revision',
      'enviada',
      'ganada',
      'nueva',
      'perdida',
    ]);
    for (const q of qs) {
      let actual: Quote['status'] = 'nueva';
      for (const h of q.history.filter((x) => x.tipo === 'estado')) {
        expect(h.de).toBe(actual);
        expect(canTransition(h.de, h.a)).toBe(true);
        actual = h.a!;
      }
      expect(actual).toBe(q.status);
      expect(q.rev).toBe(q.history.length + 1);
    }
  });

  it('cotizada o posterior trae finalQuote con totales correctos; perdida trae motivo', () => {
    for (const q of rows.map(domain)) {
      if (['cotizada', 'enviada', 'ganada', 'perdida'].includes(q.status)) {
        const fq = q.finalQuote!;
        const again = computeFinalQuote({
          items: q.items,
          prices: fq.items,
          fleteFinal: fq.fleteFinal,
          vigenciaDias: fq.vigenciaDias,
        });
        expect(fq.total).toBe(again.total);
        expect(fq.subtotal).toBe(again.subtotal);
        expect(fq.vigenciaDias).toBe(15);
      }
      if (['enviada', 'ganada', 'perdida'].includes(q.status)) {
        expect(q.finalQuote!.enviadaAt).toBeDefined();
        expect(q.respondedAt).toBeDefined();
      }
      if (q.status === 'perdida') expect(q.lostReason).toBeDefined();
      if (q.status === 'nueva') expect(q.finalQuote).toBeUndefined();
    }
  });

  it('el estimado de flete sale de estimateFreight con la tarifa de ejemplo t0001', () => {
    const con = rows.map(domain).filter((q) => q.freight);
    expect(con.length).toBeGreaterThan(20);
    for (const q of con) {
      expect(q.freight!.versionTarifa).toBe('t0001');
      expect(q.freight!.estimadoMax).toBeGreaterThanOrEqual(q.freight!.estimadoMin);
      expect(q.freight!.moneda).toBe('MXN');
    }
  });

  it('las fechas quedan en el pasado reciente (≤ 40 días) y nunca en el futuro', () => {
    for (const q of rows.map(domain)) {
      const t = Date.parse(q.createdAt);
      expect(t).toBeLessThanOrEqual(NOW.getTime());
      expect(NOW.getTime() - t).toBeLessThanOrEqual(41 * 86_400_000);
    }
  });

  it('incluye las claves de índice y el searchKey, y solo piedras del catálogo de ejemplo', () => {
    const ids = new Set(inputs.stones.map((s) => s.id));
    for (const r of rows) {
      expect(r['gsi1pk']).toBe(`STATUS#${r['status']}`);
      expect(r['gsi2pk']).toBe('QUOTE');
      expect(r['gsi1sk']).toBe(`${r['createdAt']}#${r['quoteId']}`);
      expect(typeof r['searchKey']).toBe('string');
      for (const i of domain(r).items) expect(ids.has(i.stoneId)).toBe(true);
    }
  });

  it('es determinista (misma entrada, mismas filas: idempotente por diseño)', () => {
    expect(build()).toEqual(build());
  });

  it('seedYearCounts coincide con los años de las filas', () => {
    const counts = seedYearCounts(NOW);
    expect(counts).toEqual({ '2026': 30 });
  });
});

describe('checkSeedEnv', () => {
  it('mismas salvaguardas que seed.ts', () => {
    expect(checkSeedEnv({})).toBe('dev');
    expect(() => checkSeedEnv({ APP_ENV: 'x' })).toThrow(/APP_ENV inválido/);
    expect(() =>
      checkSeedEnv({ APP_ENV: 'prod', AWS_ENDPOINT_URL: 'http://localhost:4566' }),
    ).toThrow();
    expect(() => checkSeedEnv({ APP_ENV: 'prod' })).toThrow(/SEED_CONFIRM_PROD/);
    expect(checkSeedEnv({ APP_ENV: 'prod', SEED_CONFIRM_PROD: 'si' })).toBe('prod');
  });
});

describe('completar un seed parcial (from)', () => {
  it('con from = n genera solo las 30 - n restantes, con los estados del plan y folios desde el contador', () => {
    const counts = seedYearCounts(NOW, 20);
    expect(counts).toEqual({ '2026': 10 });
    const rows = buildQuoteSeeds({ now: NOW, ...inputs, folioStart: { '2026': 21 }, from: 20 });
    expect(rows).toHaveLength(10);
    const todas = buildQuoteSeeds({ now: NOW, ...inputs, folioStart: { '2026': 1 } });
    expect(rows.map((r) => r['status'])).toEqual(todas.slice(20).map((r) => r['status']));
    expect(domain(rows[0]!).folio).toBe('CN-2026-00021');
  });
  it('from fuera de rango o 30 no genera nada o falla claro', () => {
    expect(seedYearCounts(NOW, 30)).toEqual({});
    expect(() => seedYearCounts(NOW, -1)).toThrow();
  });
});

describe('checkQuotesSeedEnv (prod consume contadores reales)', () => {
  it('en dev pasa; en prod exige SEED_CONFIRM_PROD=si Y SEED_ALLOW_PROD_COUNTERS=si', () => {
    expect(checkQuotesSeedEnv({})).toBe('dev');
    expect(() => checkQuotesSeedEnv({ APP_ENV: 'prod', SEED_CONFIRM_PROD: 'si' })).toThrow(
      /SEED_ALLOW_PROD_COUNTERS/,
    );
    expect(() => checkQuotesSeedEnv({ APP_ENV: 'prod', SEED_ALLOW_PROD_COUNTERS: 'si' })).toThrow(
      /SEED_CONFIRM_PROD/,
    );
    expect(
      checkQuotesSeedEnv({
        APP_ENV: 'prod',
        SEED_CONFIRM_PROD: 'si',
        SEED_ALLOW_PROD_COUNTERS: 'si',
      }),
    ).toBe('prod');
  });
});

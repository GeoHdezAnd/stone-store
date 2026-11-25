import { describe, expect, it } from 'vitest';
import { computeMetrics } from '../compute';
import { metricsResponseSchema, type MetricsResponse } from '../schema';

const NOW = Date.parse('2026-11-24T18:00:00.000Z');

function sample(): MetricsResponse {
  return {
    generatedAt: new Date(NOW).toISOString(),
    timezone: 'America/Mexico_City',
    range: { from: '2026-07-26T18:00:00.000Z', to: new Date(NOW).toISOString() },
    truncated: false,
    zonesPartial: false,
    skipped: 0,
    ...computeMetrics({ quotes: [], now: NOW, zoneByCp: {} }),
  };
}

describe('metricsResponseSchema', () => {
  it('acepta la salida de computeMetrics con su sobre', () => {
    expect(metricsResponseSchema.safeParse(sample()).success).toBe(true);
  });
  it('rechaza claves de más (strictObject): no se cuelan datos personales', () => {
    expect(metricsResponseSchema.safeParse({ ...sample(), customer: 'x' }).success).toBe(false);
    const s = sample();
    s.waiting.items.push({
      quoteId: 'a',
      folio: 'CN-2026-00001',
      status: 'nueva',
      cliente: 'x',
      lugar: 'y',
      createdAt: new Date(NOW).toISOString(),
      ageHours: 1,
      overdue: false,
      // @ts-expect-error clave que no debe existir
      telefono: '555',
    });
    expect(metricsResponseSchema.safeParse(s).success).toBe(false);
  });
  it('exige exactamente 8 semanas y 6 etapas de embudo', () => {
    const s = sample();
    expect(metricsResponseSchema.safeParse({ ...s, weekly: s.weekly.slice(1) }).success).toBe(
      false,
    );
    expect(metricsResponseSchema.safeParse({ ...s, funnel: s.funnel.slice(1) }).success).toBe(
      false,
    );
  });
  it('rechaza conteos negativos, fechas inválidas y más de 5 piedras', () => {
    const s = sample();
    expect(
      metricsResponseSchema.safeParse({
        ...s,
        weekly: s.weekly.map((w, i) => (i === 0 ? { ...w, count: -1 } : w)),
      }).success,
    ).toBe(false);
    expect(metricsResponseSchema.safeParse({ ...s, generatedAt: 'ayer' }).success).toBe(false);
    const six = Array.from({ length: 6 }, (_, i) => ({ stoneId: `s${i}`, nombre: 'n', count: 1 }));
    expect(metricsResponseSchema.safeParse({ ...s, topStones: six }).success).toBe(false);
  });
  it('el estado de «esperando respuesta» solo admite nueva, en_revision o cotizada', () => {
    const base = {
      quoteId: 'a',
      folio: 'CN-2026-00001',
      cliente: 'x',
      lugar: 'y',
      createdAt: new Date(NOW).toISOString(),
      ageHours: 1,
      overdue: false,
    };
    const withStatus = (status: string): MetricsResponse => {
      const s = sample();
      s.waiting.items.push({ ...base, status } as never);
      return s;
    };
    for (const ok of ['nueva', 'en_revision', 'cotizada']) {
      expect(metricsResponseSchema.safeParse(withStatus(ok)).success, ok).toBe(true);
    }
    for (const bad of ['enviada', 'ganada', 'otra']) {
      expect(metricsResponseSchema.safeParse(withStatus(bad)).success, bad).toBe(false);
    }
  });
  it('rechaza un huso distinto al fijado', () => {
    expect(metricsResponseSchema.safeParse({ ...sample(), timezone: 'UTC' }).success).toBe(false);
  });
});

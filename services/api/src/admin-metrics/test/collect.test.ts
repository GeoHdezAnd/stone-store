import { describe, expect, it } from 'vitest';
import { quote } from '../../admin-quotes/test/fixtures';
import {
  collectQuotes,
  MAX_PAGES_PER_QUERY,
  backoffDelay,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  BATCH_MAX_ATTEMPTS,
  MAX_ZONE_CPS,
  PAGE_SIZE,
  POSTAL_BATCH_SIZE,
  resolveZones,
} from '../collect';
import { MemoryMetricsRepository } from './memory-repository';

const id = (n: number): string =>
  `01ARZ3NDEKTSV4RRFFQ69G${String(n).padStart(4, '0')}`.slice(0, 26);
function seedMany(repo: MemoryMetricsRepository, n: number): void {
  for (let i = 1; i <= n; i++) {
    repo.seed(
      quote({
        quoteId: id(i),
        folio: `CN-2026-${String(i).padStart(5, '0')}`,
        createdAt: new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString(),
        status: 'nueva',
      }),
    );
  }
}

describe('constantes de tope', () => {
  it('páginas de 200, 10 páginas por consulta, lotes de 100 CP y 300 CP como máximo', () => {
    expect(PAGE_SIZE).toBe(200);
    expect(MAX_PAGES_PER_QUERY).toBe(10);
    expect(POSTAL_BATCH_SIZE).toBe(100);
    expect(MAX_ZONE_CPS).toBe(300);
  });
});

describe('collectQuotes', () => {
  it('pagina hasta agotar el índice y no marca truncado', async () => {
    const repo = new MemoryMetricsRepository();
    seedMany(repo, 7);
    const r = await collectQuotes(repo, [{ index: 'date' }], { pageSize: 3, maxPages: 10 });
    expect(r.rows).toHaveLength(7);
    expect(r.truncated).toBe(false);
    expect(repo.queries.map((q) => q.limit)).toEqual([3, 3, 3]);
  });
  it('marca truncado y se detiene al llegar al tope de páginas con más datos pendientes', async () => {
    const repo = new MemoryMetricsRepository();
    seedMany(repo, 7);
    const r = await collectQuotes(repo, [{ index: 'date' }], { pageSize: 2, maxPages: 2 });
    expect(r.rows).toHaveLength(4);
    expect(r.truncated).toBe(true);
    expect(repo.calls).toEqual(['query', 'query']);
  });
  it('no marca truncado si justo en la última página permitida ya no hay más', async () => {
    const repo = new MemoryMetricsRepository();
    seedMany(repo, 4);
    const r = await collectQuotes(repo, [{ index: 'date' }], { pageSize: 2, maxPages: 2 });
    expect(r.rows).toHaveLength(4);
    expect(r.truncated).toBe(false);
  });
  it('junta varias consultas (por estado y por fecha) y pasa estado y rango a cada una', async () => {
    const repo = new MemoryMetricsRepository();
    seedMany(repo, 3);
    const r = await collectQuotes(
      repo,
      [
        { index: 'status', status: 'nueva' },
        { index: 'status', status: 'en_revision' },
        { index: 'date', from: '2026-11-01T00:00:00.000Z', to: 'zzz' },
      ],
      { pageSize: 50, maxPages: 3 },
    );
    expect(r.rows).toHaveLength(6); // 3 por estado + 3 por fecha (el llamador deduplica)
    expect(repo.queries.map((q) => [q.index, q.status ?? null])).toEqual(
      expect.arrayContaining([
        ['status', 'nueva'],
        ['status', 'en_revision'],
        ['date', null],
      ]),
    );
  });
  it('si una consulta falla, el error se propaga (el handler responde 500 genérico)', async () => {
    const repo = new MemoryMetricsRepository();
    repo.queryError = new Error('boom');
    await expect(collectQuotes(repo, [{ index: 'date' }])).rejects.toThrow('boom');
  });
});

describe('resolveZones', () => {
  const codes = (n: number): string => String(n).padStart(5, '0');
  it('sin códigos no consulta nada', async () => {
    const repo = new MemoryMetricsRepository();
    expect(await resolveZones(repo, [])).toEqual({ zoneByCp: {}, partial: false });
    expect(repo.calls).toEqual([]);
  });
  it('divide en lotes de 100 y devuelve el estado de los CP que existen', async () => {
    const repo = new MemoryMetricsRepository();
    repo.postalCodes.set('00001', 'Puebla');
    const list = Array.from({ length: 250 }, (_, i) => codes(i + 1));
    const r = await resolveZones(repo, list);
    expect(repo.batches.map((b) => b.length)).toEqual([100, 100, 50]);
    expect(r).toEqual({ zoneByCp: { '00001': 'Puebla' }, partial: false });
  });
  it('reintenta las claves sin procesar', async () => {
    const repo = new MemoryMetricsRepository();
    repo.postalCodes.set('72810', 'Puebla');
    repo.unprocessedOnce.add('72810');
    const r = await resolveZones(repo, ['72810']);
    expect(r).toEqual({ zoneByCp: { '72810': 'Puebla' }, partial: false });
    expect(repo.batches).toEqual([['72810'], ['72810']]);
  });
  it('si siguen sin procesar tras los reintentos marca parcial y no cuelga', async () => {
    const repo = new MemoryMetricsRepository();
    repo.alwaysUnprocessed.add('72810');
    const r = await resolveZones(repo, ['72810', '90000']);
    expect(r.partial).toBe(true);
    expect(repo.batches.length).toBeLessThanOrEqual(4);
  });
  it('ignora estados vacíos o con forma inválida', async () => {
    const repo = new MemoryMetricsRepository();
    repo.postalCodes.set('72810', '   ');
    const r = await resolveZones(repo, ['72810']);
    expect(r.zoneByCp).toEqual({});
  });
});

describe('resolveZones: reintentos con backoff exponencial y jitter', () => {
  const setup = () => {
    const repo = new MemoryMetricsRepository();
    const sleeps: number[] = [];
    const retry = {
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      random: () => 1,
    };
    return { repo, sleeps, retry };
  };
  it('constantes: 4 intentos, base 50 ms y espera máxima 400 ms', () => {
    expect(BATCH_MAX_ATTEMPTS).toBe(4);
    expect(BACKOFF_BASE_MS).toBe(50);
    expect(BACKOFF_MAX_MS).toBe(400);
  });
  it('sin claves pendientes no espera nunca', async () => {
    const { repo, sleeps, retry } = setup();
    await resolveZones(repo, ['72810'], retry);
    expect(sleeps).toEqual([]);
  });
  it('espera base·2^n entre intentos (jitter máximo) y nunca después del último', async () => {
    const { repo, sleeps, retry } = setup();
    repo.alwaysUnprocessed.add('72810');
    const r = await resolveZones(repo, ['72810'], retry);
    expect(r.partial).toBe(true);
    expect(repo.batches).toHaveLength(BATCH_MAX_ATTEMPTS);
    expect(sleeps).toEqual([50, 100, 200]);
  });
  it('la espera se limita a BACKOFF_MAX_MS', async () => {
    const { repo, sleeps, retry } = setup();
    repo.alwaysUnprocessed.add('72810');
    await resolveZones(repo, ['72810'], retry);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(BACKOFF_MAX_MS);
  });
  it('el jitter es completo: con random() = 0 la espera es 0 y con 0.5 la mitad', async () => {
    const a = setup();
    a.repo.alwaysUnprocessed.add('72810');
    await resolveZones(a.repo, ['72810'], { ...a.retry, random: () => 0 });
    expect(a.sleeps).toEqual([0, 0, 0]);
    const b = setup();
    b.repo.alwaysUnprocessed.add('72810');
    await resolveZones(b.repo, ['72810'], { ...b.retry, random: () => 0.5 });
    expect(b.sleeps).toEqual([25, 50, 100]);
  });
  it('si el reintento resuelve, solo espera una vez', async () => {
    const { repo, sleeps, retry } = setup();
    repo.postalCodes.set('72810', 'Puebla');
    repo.unprocessedOnce.add('72810');
    const r = await resolveZones(repo, ['72810'], retry);
    expect(r.partial).toBe(false);
    expect(sleeps).toEqual([50]);
  });
});

describe('backoffDelay', () => {
  it('crece como base·2^n con jitter completo y se topa en BACKOFF_MAX_MS', () => {
    expect([1, 2, 3].map((n) => backoffDelay(n, () => 1))).toEqual([50, 100, 200]);
    expect(backoffDelay(4, () => 1)).toBe(400);
    expect(backoffDelay(10, () => 1)).toBe(BACKOFF_MAX_MS);
    expect(backoffDelay(10, () => 0.5)).toBe(BACKOFF_MAX_MS / 2);
    expect(backoffDelay(3, () => 0)).toBe(0);
  });
});

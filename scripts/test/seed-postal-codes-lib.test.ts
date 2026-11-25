import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { freightConfigSchema } from '../../packages/shared/src/index';
import { readFreightContent } from '../seed-freight-lib';
import {
  BATCH_WRITE_SIZE,
  buildPostalCodesSeed,
  chunk,
  PostalCodesSeedValidationError,
  readPostalCodesContent,
  selectNewPostalCodes,
} from '../seed-postal-codes-lib';

const CONTENT = join(import.meta.dirname, '..', '..', 'content');
const real = (): Record<string, unknown> =>
  structuredClone(readPostalCodesContent(CONTENT)) as Record<string, unknown>;

describe('buildPostalCodesSeed', () => {
  it('lee y valida content/postal-codes.json', () => {
    const items = buildPostalCodesSeed(real());
    expect(items.length).toBeGreaterThanOrEqual(10);
    expect(items.every((i) => /^\d{5}$/.test(i.cp))).toBe(true);
  });

  it('rechaza si no está marcado como ejemplo', () => {
    const raw = real();
    raw['ejemplo'] = false;
    expect(() => buildPostalCodesSeed(raw)).toThrow(PostalCodesSeedValidationError);
    expect(() => buildPostalCodesSeed(raw)).toThrow(/ejemplo/);
    delete raw['ejemplo'];
    expect(() => buildPostalCodesSeed(raw)).toThrow(/ejemplo/);
  });

  it('rechaza un item inválido e indica el campo', () => {
    const raw = real();
    (raw['items'] as Record<string, unknown>[])[0]!['lat'] = 200;
    expect(() => buildPostalCodesSeed(raw)).toThrow(/items\.0\.lat/);
  });

  it('rechaza cps repetidos', () => {
    const raw = real();
    const items = raw['items'] as Record<string, unknown>[];
    items.push(structuredClone(items[0]!));
    expect(() => buildPostalCodesSeed(raw)).toThrow(/repetir/);
  });

  it('rechaza contenido que no es un objeto', () => {
    for (const raw of [null, [], 'x', 3]) {
      expect(() => buildPostalCodesSeed(raw)).toThrow(PostalCodesSeedValidationError);
    }
  });
});

describe('content/postal-codes.json', () => {
  it('todos los cps de ejemplo caen dentro de las zonas cubiertas de la tarifa de ejemplo', () => {
    const { zonasCubiertas } = freightConfigSchema.parse(readFreightContent(CONTENT));
    for (const { cp } of buildPostalCodesSeed(real())) {
      expect(
        zonasCubiertas.some((z) => cp.startsWith(z)),
        cp,
      ).toBe(true);
    }
  });

  it('cubre Puebla, Tlaxcala, Veracruz y Ciudad de México', () => {
    const estados = new Set(buildPostalCodesSeed(real()).map((i) => i.estado));
    for (const e of ['Puebla', 'Tlaxcala', 'Veracruz', 'Ciudad de México']) {
      expect(estados.has(e), e).toBe(true);
    }
  });
});

describe('chunk', () => {
  it('parte en lotes del tamaño pedido', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 25)).toEqual([]);
  });

  it('rechaza un tamaño inválido', () => {
    expect(() => chunk([1], 0)).toThrow();
    expect(() => chunk([1], 1.5)).toThrow();
  });

  it('BatchWriteItem admite 25 por lote', () => {
    expect(BATCH_WRITE_SIZE).toBe(25);
  });
});

describe('selectNewPostalCodes (no sobrescribe lo que ya existe)', () => {
  const items = buildPostalCodesSeed(real());

  it('con tabla vacía escribe todo', () => {
    const r = selectNewPostalCodes(items, new Set());
    expect(r.toWrite).toHaveLength(items.length);
    expect(r.skipped).toBe(0);
  });

  it('omite los cps que ya existen', () => {
    const r = selectNewPostalCodes(items, new Set([items[0]!.cp, items[1]!.cp]));
    expect(r.toWrite.map((i) => i.cp)).not.toContain(items[0]!.cp);
    expect(r.toWrite.map((i) => i.cp)).not.toContain(items[1]!.cp);
    expect(r.toWrite).toHaveLength(items.length - 2);
    expect(r.skipped).toBe(2);
  });

  it('si todo existe no escribe nada', () => {
    const r = selectNewPostalCodes(items, new Set(items.map((i) => i.cp)));
    expect(r.toWrite).toEqual([]);
    expect(r.skipped).toBe(items.length);
  });
});

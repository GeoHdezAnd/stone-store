import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { freightConfigSchema } from '@canteras/shared';

const CONTENT = join(import.meta.dirname, '..', '..', 'content');

describe('content/freight-config.json', () => {
  it('es una configuración de flete válida y está marcada como ejemplo', () => {
    const raw: unknown = JSON.parse(readFileSync(join(CONTENT, 'freight-config.json'), 'utf8'));
    const cfg = freightConfigSchema.parse(raw);
    expect(cfg.ejemplo).toBe(true);
    expect(cfg.camiones).toHaveLength(3);
    expect(cfg.maxKm).toBe(350);
  });

  it('cubre solo Puebla (72-75), Tlaxcala (90), Veracruz (91-96) y CDMX (01-16)', () => {
    const raw: unknown = JSON.parse(readFileSync(join(CONTENT, 'freight-config.json'), 'utf8'));
    const { zonasCubiertas } = freightConfigSchema.parse(raw);
    const esperadas = [
      ...['72', '73', '74', '75'],
      '90',
      ...['91', '92', '93', '94', '95', '96'],
      ...Array.from({ length: 16 }, (_, i) => String(i + 1).padStart(2, '0')),
    ];
    expect([...zonasCubiertas].sort()).toEqual([...esperadas].sort());
    for (const fuera of ['97', '98', '99']) expect(zonasCubiertas).not.toContain(fuera);
  });
});

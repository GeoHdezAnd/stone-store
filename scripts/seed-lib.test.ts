import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildSeedPlan, readContent, SeedValidationError, type RawContent } from './seed-lib';

const CONTENT = join(import.meta.dirname, '..', 'content');
const real = (): RawContent => structuredClone(readContent(CONTENT));

function item(raw: unknown, i = 0): Record<string, unknown> {
  return (raw as { items: Record<string, unknown>[] }).items[i] as Record<string, unknown>;
}

function mensajes(raw: RawContent): string {
  try {
    buildSeedPlan(raw);
  } catch (e) {
    expect(e).toBeInstanceOf(SeedValidationError);
    return (e as Error).message;
  }
  throw new Error('se esperaba un error de validación');
}

describe('seed: contenido de ejemplo', () => {
  it('el contenido de content/ es válido y consistente', () => {
    expect(() => buildSeedPlan(real())).not.toThrow();
  });

  it('arma los items esperados por tabla', () => {
    const plan = Object.fromEntries(buildSeedPlan(real()).map((t) => [t.table, t]));
    expect(plan['Stones']?.items).toHaveLength(8);
    expect(plan['Finishes']?.items).toHaveLength(9);
    expect(plan['Services']?.items).toHaveLength(7);
    expect(plan['Projects']?.items).toHaveLength(3);
    expect(plan['Stones']?.key).toBe('id');
    expect(plan['Settings']?.key).toBe('key');
  });

  it('guarda settings como filas PUBLIC y MAIL', () => {
    const settings = buildSeedPlan(real()).find((t) => t.table === 'Settings');
    const claves = settings?.items.map((i) => i['key']);
    expect(claves).toEqual(['PUBLIC', 'MAIL']);
    expect(settings?.items[0]).toHaveProperty('nombrePatio');
    expect(settings?.items[1]).toHaveProperty('plantillaCotizacion');
  });

  it('dos proyectos publicados y uno en borrador', () => {
    const projects = buildSeedPlan(real()).find((t) => t.table === 'Projects');
    const estados = projects?.items.map((p) => p['estado']).sort();
    expect(estados).toEqual(['borrador', 'publicado', 'publicado']);
  });
});

describe('seed: rechazo de datos inválidos', () => {
  it('rechaza un archivo sin el campo "ejemplo"', () => {
    const raw = real();
    delete (raw.stones as Record<string, unknown>)['ejemplo'];
    expect(mensajes(raw)).toContain('stones.json: falta el campo booleano "ejemplo"');
  });

  it('rechaza una piedra que no cumple el esquema', () => {
    const raw = real();
    item(raw.stones)['densidadKgM3'] = 10;
    expect(mensajes(raw)).toContain('stones.json[0].densidadKgM3');
  });

  it('rechaza campos extra (esquemas estrictos)', () => {
    const raw = real();
    item(raw.finishes)['extra'] = 'x';
    expect(mensajes(raw)).toContain('finishes.json[0]');
  });

  it('rechaza ids repetidos', () => {
    const raw = real();
    item(raw.services, 1)['id'] = item(raw.services, 0)['id'];
    expect(mensajes(raw)).toContain('id repetido');
  });

  it('rechaza una plantilla con variables no permitidas', () => {
    const raw = real();
    ((raw.settings as Record<string, unknown>)['mail'] as Record<string, unknown>)[
      'asuntoCotizacion'
    ] = 'Hola {{secreto}}';
    expect(mensajes(raw)).toContain('settings.json.mail.asuntoCotizacion');
  });

  it('rechaza si "items" no es una lista', () => {
    const raw = real();
    (raw.projects as Record<string, unknown>)['items'] = {};
    expect(mensajes(raw)).toContain('projects.json: "items" debe ser una lista');
  });
});

describe('seed: integridad referencial', () => {
  it('detecta una piedra que apunta a un acabado inexistente', () => {
    const raw = real();
    item(raw.stones)['acabados'] = ['Acabado fantasma'];
    expect(mensajes(raw)).toContain('el acabado "Acabado fantasma" no existe');
  });

  it('detecta una piedra con proyecto relacionado inexistente', () => {
    const raw = real();
    item(raw.stones)['proyectosRelacionados'] = ['no-existe'];
    expect(mensajes(raw)).toContain('el proyecto "no-existe" no existe');
  });

  it('detecta un proyecto con piedra o acabado inexistente', () => {
    const raw = real();
    item(raw.projects)['piedras'] = ['no-existe'];
    item(raw.projects)['acabados'] = ['tampoco'];
    const msg = mensajes(raw);
    expect(msg).toContain('la piedra "no-existe" no existe');
    expect(msg).toContain('el acabado "tampoco" no existe');
  });
});

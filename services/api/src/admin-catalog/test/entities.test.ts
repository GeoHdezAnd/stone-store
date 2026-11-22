import { describe, expect, it } from 'vitest';
import { ENTITIES, ENTITY_NAMES, TABLE_ENV } from '../entities';
import { finish, project, service, stone } from './fixtures';

describe('configuración de entidades', () => {
  it('mapea cada entidad a su segmento, tabla y tipo de auditoría', () => {
    expect(ENTITY_NAMES).toEqual(['stone', 'project', 'finish', 'service']);
    expect(ENTITIES.stone.segment).toBe('stones');
    expect(ENTITIES.project.segment).toBe('projects');
    expect(ENTITIES.finish.segment).toBe('finishes');
    expect(ENTITIES.service.segment).toBe('services');
    expect(TABLE_ENV).toEqual({
      stone: 'STONES_TABLE',
      project: 'PROJECTS_TABLE',
      finish: 'FINISHES_TABLE',
      service: 'SERVICES_TABLE',
    });
  });

  it('cada esquema acepta su ejemplo válido y exige activa', () => {
    const ejemplos = { stone: stone(), project: project(), finish: finish(), service: service() };
    for (const name of ENTITY_NAMES) {
      const ejemplo = ejemplos[name];
      expect(ENTITIES[name].schema.safeParse(ejemplo).success, name).toBe(true);
      const sinActiva = Object.fromEntries(Object.entries(ejemplo).filter(([k]) => k !== 'activa'));
      expect(ENTITIES[name].schema.safeParse(sinActiva).success, name).toBe(false);
    }
  });

  it('declara solo las referencias acordadas (stone.acabados son nombres libres)', () => {
    const resumen = (name: (typeof ENTITY_NAMES)[number]) =>
      ENTITIES[name].references.map((r) => `${r.field}->${r.target}`);
    expect(resumen('project')).toEqual(['piedras->stone', 'acabados->finish']);
    expect(resumen('stone')).toEqual(['proyectosRelacionados->project']);
    expect(resumen('finish')).toEqual([]);
    expect(resumen('service')).toEqual([]);
  });

  it('extrae los ids a comprobar de cada entidad', () => {
    const p = project({ piedras: ['a', 'b'], acabados: ['c'] });
    expect(ENTITIES.project.references.map((r) => r.pick(p))).toEqual([['a', 'b'], ['c']]);
    const s = stone({ proyectosRelacionados: ['x'], acabados: ['Nombre libre'] });
    expect(ENTITIES.stone.references.map((r) => r.pick(s))).toEqual([['x']]);
  });
});

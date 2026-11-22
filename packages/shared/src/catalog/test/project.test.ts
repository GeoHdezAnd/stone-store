import { describe, expect, it } from 'vitest';
import { projectSchema } from '../project';

// Datos de EJEMPLO (proyecto académico).
const valido = {
  id: 'casa-tepeyahualco',
  titulo: 'Casa Tepeyahualco',
  categoria: 'fachadas',
  ubicacion: 'Puebla, Puebla',
  anio: 2024,
  descripcion: 'Fachada de arenisca labrada (dato de ejemplo).',
  superficie: '210 m²',
  piedras: ['arenisca'],
  acabados: ['labrado'],
  piezasLabradas: 12,
  entrega: '6 semanas',
  testimonio: { texto: 'Quedó excelente (ejemplo).', autor: 'Cliente de ejemplo' },
  fotos: ['projects/casa-tepeyahualco/1.jpg'],
  estado: 'publicado',
  activa: true,
};

describe('projectSchema', () => {
  it('rechaza activa que no sea booleano', () => {
    expect(projectSchema.safeParse({ ...valido, activa: null }).success).toBe(false);
  });

  it('parsea un ejemplo válido completo', () => {
    expect(projectSchema.parse(valido)).toEqual(valido);
  });

  it('acepta piezasLabradas y testimonio nulos', () => {
    expect(
      projectSchema.safeParse({ ...valido, piezasLabradas: null, testimonio: null }).success,
    ).toBe(true);
  });

  it('falla si falta cualquier campo obligatorio', () => {
    for (const campo of Object.keys(valido)) {
      const resto = Object.fromEntries(Object.entries(valido).filter(([k]) => k !== campo));
      expect(projectSchema.safeParse(resto).success, campo).toBe(false);
    }
  });

  it('rechaza claves extra, también dentro del testimonio', () => {
    expect(projectSchema.safeParse({ ...valido, extra: 1 }).success).toBe(false);
    expect(
      projectSchema.safeParse({ ...valido, testimonio: { ...valido.testimonio, x: 1 } }).success,
    ).toBe(false);
  });

  it('rechaza categorías y estados fuera del enum', () => {
    expect(projectSchema.safeParse({ ...valido, categoria: 'otra' }).success).toBe(false);
    expect(projectSchema.safeParse({ ...valido, estado: 'archivado' }).success).toBe(false);
  });

  it('valida el rango y tipo de anio y piezasLabradas', () => {
    for (const anio of [1899, 2101, 2024.5, Number.NaN]) {
      expect(projectSchema.safeParse({ ...valido, anio }).success, String(anio)).toBe(false);
    }
    for (const piezasLabradas of [-1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(
        projectSchema.safeParse({ ...valido, piezasLabradas }).success,
        String(piezasLabradas),
      ).toBe(false);
    }
  });

  it('respeta los límites de longitud y de listas', () => {
    expect(projectSchema.safeParse({ ...valido, titulo: 'x'.repeat(121) }).success).toBe(false);
    expect(projectSchema.safeParse({ ...valido, descripcion: 'x'.repeat(4001) }).success).toBe(
      false,
    );
    expect(
      projectSchema.safeParse({ ...valido, fotos: Array(31).fill('projects/a/1.jpg') }).success,
    ).toBe(false);
    expect(
      projectSchema.safeParse({ ...valido, piedras: Array.from({ length: 51 }, (_, i) => `p${i}`) })
        .success,
    ).toBe(false);
  });

  it('rechaza ids inválidos en id, piedras y acabados', () => {
    expect(projectSchema.safeParse({ ...valido, id: 'Casa Uno' }).success).toBe(false);
    expect(projectSchema.safeParse({ ...valido, piedras: ['../x'] }).success).toBe(false);
    expect(projectSchema.safeParse({ ...valido, acabados: ['A B'] }).success).toBe(false);
  });

  it('rechaza piedras o acabados repetidos', () => {
    expect(projectSchema.safeParse({ ...valido, piedras: ['a', 'a'] }).success).toBe(false);
    expect(projectSchema.safeParse({ ...valido, acabados: ['a', 'a'] }).success).toBe(false);
  });

  it('rechaza fotos inválidas', () => {
    for (const foto of [
      'http://x.com/projects/a/1.jpg',
      'projects/../x/1.jpg',
      'stones/a/1.jpg',
      'projects/a/1.svg',
      'projects/a/1.exe',
      '/projects/a/1.jpg',
    ]) {
      expect(projectSchema.safeParse({ ...valido, fotos: [foto] }).success, foto).toBe(false);
    }
  });
});

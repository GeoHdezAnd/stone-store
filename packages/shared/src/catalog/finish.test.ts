import { describe, expect, it } from 'vitest';
import { finishSchema } from './finish';

// Datos de EJEMPLO (proyecto académico).
const valido = {
  id: 'apomazado',
  nombre: 'Apomazado',
  descripcion: 'Superficie lisa y mate, sin brillo.',
  foto: 'finishes/apomazado/1.jpg',
  activa: true,
};

describe('finishSchema', () => {
  it('rechaza activa que no sea booleano', () => {
    expect(finishSchema.safeParse({ ...valido, activa: 'si' }).success).toBe(false);
  });

  it('parsea un ejemplo válido completo', () => {
    expect(finishSchema.parse(valido)).toEqual(valido);
  });

  it('acepta foto nula', () => {
    expect(finishSchema.safeParse({ ...valido, foto: null }).success).toBe(true);
  });

  it('falla si falta cualquier campo obligatorio', () => {
    for (const campo of Object.keys(valido)) {
      const resto = Object.fromEntries(Object.entries(valido).filter(([k]) => k !== campo));
      expect(finishSchema.safeParse(resto).success, campo).toBe(false);
    }
  });

  it('rechaza claves extra', () => {
    expect(finishSchema.safeParse({ ...valido, admin: true }).success).toBe(false);
  });

  it('respeta los límites de longitud', () => {
    expect(finishSchema.safeParse({ ...valido, nombre: 'x'.repeat(121) }).success).toBe(false);
    expect(finishSchema.safeParse({ ...valido, nombre: '' }).success).toBe(false);
    expect(finishSchema.safeParse({ ...valido, descripcion: 'x'.repeat(4001) }).success).toBe(
      false,
    );
  });

  it('rechaza ids inválidos', () => {
    for (const id of ['Apomazado', 'a b', '../x']) {
      expect(finishSchema.safeParse({ ...valido, id }).success, id).toBe(false);
    }
  });

  it('rechaza fotos inválidas', () => {
    for (const foto of [
      'http://x.com/finishes/a/1.jpg',
      'finishes/../x/1.jpg',
      'stones/a/1.jpg',
      'finishes/a/1.svg',
      'finishes/a/1.exe',
      '/finishes/a/1.jpg',
    ]) {
      expect(finishSchema.safeParse({ ...valido, foto }).success, foto).toBe(false);
    }
  });
});

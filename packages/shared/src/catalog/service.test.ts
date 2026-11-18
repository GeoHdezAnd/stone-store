import { describe, expect, it } from 'vitest';
import { serviceSchema } from './service';

// Datos de EJEMPLO (proyecto académico).
const valido = {
  id: 'piedra-en-bruto',
  titulo: 'Piedra en bruto',
  descripcion: 'Bloques sin labrar, directo del banco.',
  activa: true,
};

describe('serviceSchema', () => {
  it('rechaza activa que no sea booleano', () => {
    expect(serviceSchema.safeParse({ ...valido, activa: 1 }).success).toBe(false);
  });

  it('parsea un ejemplo válido completo', () => {
    expect(serviceSchema.parse(valido)).toEqual(valido);
  });

  it('falla si falta cualquier campo obligatorio', () => {
    for (const campo of Object.keys(valido)) {
      const resto = Object.fromEntries(Object.entries(valido).filter(([k]) => k !== campo));
      expect(serviceSchema.safeParse(resto).success, campo).toBe(false);
    }
  });

  it('rechaza claves extra', () => {
    expect(serviceSchema.safeParse({ ...valido, extra: 1 }).success).toBe(false);
  });

  it('respeta los límites de longitud', () => {
    expect(serviceSchema.safeParse({ ...valido, titulo: 'x'.repeat(121) }).success).toBe(false);
    expect(serviceSchema.safeParse({ ...valido, descripcion: 'x'.repeat(4001) }).success).toBe(
      false,
    );
    expect(serviceSchema.safeParse({ ...valido, titulo: '' }).success).toBe(false);
  });

  it('rechaza ids con mayúsculas, espacios o rutas', () => {
    for (const id of ['Piedra', 'a b', '../x']) {
      expect(serviceSchema.safeParse({ ...valido, id }).success, id).toBe(false);
    }
  });
});

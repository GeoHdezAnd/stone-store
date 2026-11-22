import { describe, expect, it } from 'vitest';
import { idSchema, photoKeySchema } from '../common';

describe('idSchema', () => {
  it('acepta slugs válidos', () => {
    for (const id of ['arenisca', 'cantera-rosa', 'laja-2', 'a']) {
      expect(idSchema.safeParse(id).success).toBe(true);
    }
  });

  it('rechaza mayúsculas, espacios, rutas y guiones mal puestos', () => {
    for (const id of [
      'Arenisca',
      'cantera rosa',
      '../etc',
      'a/b',
      '-a',
      'a-',
      'a--b',
      'ñandú',
      '',
    ]) {
      expect(idSchema.safeParse(id).success, id).toBe(false);
    }
  });

  it('rechaza más de 64 caracteres y acepta exactamente 64', () => {
    expect(idSchema.safeParse('a'.repeat(64)).success).toBe(true);
    expect(idSchema.safeParse('a'.repeat(65)).success).toBe(false);
  });

  it('rechaza valores que no son texto', () => {
    expect(idSchema.safeParse(null).success).toBe(false);
    expect(idSchema.safeParse(5).success).toBe(false);
  });
});

describe('photoKeySchema', () => {
  const stones = photoKeySchema('stones');

  it('acepta una clave válida de la carpeta correcta', () => {
    expect(stones.safeParse('stones/arenisca/1.jpg').success).toBe(true);
    expect(photoKeySchema('projects').safeParse('projects/casa-1/foto_01.webp').success).toBe(true);
    expect(photoKeySchema('finishes').safeParse('finishes/apomazado/a.avif').success).toBe(true);
  });

  it('rechaza URLs con esquema', () => {
    expect(stones.safeParse('http://evil.com/stones/a/1.jpg').success).toBe(false);
    expect(stones.safeParse('https://x.com/stones/a/1.jpg').success).toBe(false);
  });

  it('rechaza recorridos de ruta y barra inicial', () => {
    expect(stones.safeParse('stones/../secret/1.jpg').success).toBe(false);
    expect(stones.safeParse('stones/a/../1.jpg').success).toBe(false);
    expect(stones.safeParse('/stones/a/1.jpg').success).toBe(false);
  });

  it('rechaza una carpeta que no corresponde a la entidad', () => {
    expect(stones.safeParse('projects/a/1.jpg').success).toBe(false);
    expect(photoKeySchema('projects').safeParse('stones/a/1.jpg').success).toBe(false);
  });

  it('rechaza extensiones no permitidas', () => {
    for (const ext of ['svg', 'exe', 'gif', 'html']) {
      expect(stones.safeParse(`stones/a/1.${ext}`).success, ext).toBe(false);
    }
  });

  it('rechaza claves demasiado largas', () => {
    expect(stones.safeParse(`stones/a/${'x'.repeat(300)}.jpg`).success).toBe(false);
  });
});

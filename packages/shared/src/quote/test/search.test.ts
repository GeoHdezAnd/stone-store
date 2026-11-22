import { describe, expect, it } from 'vitest';
import {
  buildSearchKey,
  normalizeSearchQuery,
  normalizeSearchText,
  quoteIndexKeys,
} from '../search';

describe('búsqueda', () => {
  it('normaliza a minúsculas sin acentos y colapsa espacios', () => {
    expect(normalizeSearchText('  José   MUÑOZ  Ñandú ')).toBe('jose munoz nandu');
  });

  it('searchKey junta folio, nombre, teléfono (solo dígitos) y CP', () => {
    const key = buildSearchKey({
      folio: 'CN-2026-00042',
      customer: { nombre: 'María Pérez', telefono: '(222) 555-0100', correo: 'maria@example.com' },
      works: { codigoPostal: '74000' },
    });
    expect(key).toBe('cn-2026-00042 maria perez 2225550100 74000');
    expect(key).not.toContain('example.com');
  });

  it('quoteIndexKeys arma las claves de los dos GSI', () => {
    const k = quoteIndexKeys({
      quoteId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      status: 'nueva',
      createdAt: '2026-11-19T10:00:00.000Z',
      folio: 'CN-2026-00001',
      customer: { nombre: 'A', telefono: '5550100', correo: 'a@example.com' },
      works: { codigoPostal: '74000' },
    });
    expect(k).toMatchObject({
      gsi1pk: 'STATUS#nueva',
      gsi1sk: '2026-11-19T10:00:00.000Z#01ARZ3NDEKTSV4RRFFQ69G5FAV',
      gsi2pk: 'QUOTE',
      gsi2sk: '2026-11-19T10:00:00.000Z#01ARZ3NDEKTSV4RRFFQ69G5FAV',
    });
  });
});

describe('normalizeSearchQuery', () => {
  it('un teléfono con +, espacios, guiones o paréntesis se reduce a dígitos', () => {
    expect(normalizeSearchQuery('+52 222 555')).toBe('52222555');
    expect(normalizeSearchQuery('(222) 555-0100')).toBe('2225550100');
  });
  it('un folio o texto normal solo se normaliza (no se pierden letras ni guiones)', () => {
    expect(normalizeSearchQuery('CN-2026-00042')).toBe('cn-2026-00042');
    expect(normalizeSearchQuery('2026-00042')).toBe('2026-00042');
    expect(normalizeSearchQuery('  José  ')).toBe('jose');
    expect(normalizeSearchQuery('74000')).toBe('74000');
  });
  it('encuentra el teléfono guardado con lada', () => {
    const key = buildSearchKey({
      folio: 'CN-2026-00042',
      customer: { nombre: 'A', telefono: '+52 222 555 0100', correo: 'a@example.com' },
      works: { codigoPostal: '74000' },
    });
    expect(key.includes(normalizeSearchQuery('+52 222 555'))).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from '../cursor';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

describe('cursor de paginación', () => {
  it('ida y vuelta', () => {
    expect(decodeCursor(encodeCursor('cantera-rosa'))).toEqual({ id: 'cantera-rosa' });
  });

  it('usa base64url sin relleno', () => {
    expect(encodeCursor('a')).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each([
    ['base64 inválido', '!!!'],
    ['cadena vacía', ''],
    ['JSON inválido', b64('no es json')],
    ['JSON que no es objeto', b64('[]')],
    ['null', b64('null')],
    ['clave extra', b64('{"id":"a","x":1}')],
    ['id con ../', b64('{"id":"../x"}')],
    ['id no texto', b64('{"id":1}')],
    ['id con mayúsculas', b64('{"id":"ABC"}')],
    ['sin id', b64('{}')],
    ['demasiado largo', 'A'.repeat(2000)],
  ])('rechaza %s', (_n, raw) => {
    expect(decodeCursor(raw)).toBeNull();
  });
});

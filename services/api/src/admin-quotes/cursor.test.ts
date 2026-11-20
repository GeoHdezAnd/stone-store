import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from './cursor';

const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const SK = `2026-11-19T10:00:00.000Z#${ID}`;
const byStatus = { quoteId: ID, gsi1pk: 'STATUS#nueva', gsi1sk: SK };
const byDate = { quoteId: ID, gsi2pk: 'QUOTE', gsi2sk: SK };
const forge = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

describe('cursor de solicitudes', () => {
  it('ida y vuelta por estado y por fecha', () => {
    expect(decodeCursor(encodeCursor(byStatus), { status: 'nueva' })).toEqual(byStatus);
    expect(decodeCursor(encodeCursor(byDate), {})).toEqual(byDate);
  });

  it('un cursor fuera del rango from/to de la consulta se rechaza', () => {
    const c = encodeCursor(byDate);
    expect(
      decodeCursor(c, { from: '2026-11-01T00:00:00.000Z', to: '2026-11-30T23:59:59.999Z#~' }),
    ).toEqual(byDate);
    expect(decodeCursor(c, { from: '2026-11-20T00:00:00.000Z' })).toBeNull();
    expect(decodeCursor(c, { to: '2026-11-19T09:59:59.999Z#~' })).toBeNull();
  });

  it('un cursor de un estado no sirve para otro ni para la lista por fecha', () => {
    expect(decodeCursor(encodeCursor(byStatus), { status: 'cotizada' })).toBeNull();
    expect(decodeCursor(encodeCursor(byStatus), {})).toBeNull();
    expect(decodeCursor(encodeCursor(byDate), { status: 'nueva' })).toBeNull();
  });

  it.each([
    ['vacío', ''],
    ['no base64url', 'a b!'],
    ['no JSON', Buffer.from('xx').toString('base64url')],
    ['demasiado largo', 'A'.repeat(600)],
    ['campos extra', forge({ ...byDate, extra: 1 })],
    ['quoteId inválido', forge({ ...byDate, quoteId: 'x' })],
    [
      'sk que no termina en el id',
      forge({ ...byDate, gsi2sk: `2026-11-19T10:00:00.000Z#01ARZ3NDEKTSV4RRFFQ69G5FAW` }),
    ],
    ['sk mal formada', forge({ ...byDate, gsi2sk: 'hola' })],
    ['pk de otra partición', forge({ ...byDate, gsi2pk: 'OTRA' })],
    ['arreglo', forge([1])],
    ['null', forge(null)],
  ])('rechaza %s', (_n, raw) => {
    expect(decodeCursor(raw, {})).toBeNull();
  });
});

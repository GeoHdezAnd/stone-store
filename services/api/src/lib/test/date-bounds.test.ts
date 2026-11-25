import { describe, expect, it } from 'vitest';
import { HttpError } from '../http';
import { parseBound } from '../date-bounds';

describe('parseBound', () => {
  it('una fecha YYYY-MM-DD abarca el día completo en UTC', () => {
    expect(parseBound('2026-11-24', 'from')).toBe('2026-11-24T00:00:00.000Z');
    expect(parseBound('2026-11-24', 'to')).toBe('2026-11-24T23:59:59.999Z');
  });
  it('un ISO con milisegundos se devuelve tal cual', () => {
    expect(parseBound('2026-11-24T10:30:00.123Z', 'from')).toBe('2026-11-24T10:30:00.123Z');
  });
  it.each(['', 'ayer', '2026-11-24T10:30:00Z', '2026-13-01', '2026-02-30', '2026-11-24 10:00'])(
    'rechaza %j con 400 invalid_query',
    (raw) => {
      try {
        parseBound(raw, 'from');
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).status).toBe(400);
        expect((err as HttpError).code).toBe('invalid_query');
      }
    },
  );
});

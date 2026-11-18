import { describe, expect, it } from 'vitest';
import { HttpError, jsonResponse } from './http';

describe('jsonResponse', () => {
  it('arma una respuesta payload v2 con cabeceras seguras', () => {
    const res = jsonResponse(201, { ok: true });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body as string)).toEqual({ ok: true });
    expect(res.headers).toEqual({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'strict-transport-security': 'max-age=31536000; includeSubDomains',
    });
  });

  it('permite cabeceras extra pero no pisar las de seguridad', () => {
    const res = jsonResponse(200, {}, { 'x-a': '1', 'Cache-Control': 'public' });
    expect(res.headers).toMatchObject({ 'x-a': '1', 'cache-control': 'no-store' });
    expect(
      Object.keys(res.headers ?? {}).filter((k) => k.toLowerCase() === 'cache-control'),
    ).toHaveLength(1);
  });
});

describe('HttpError', () => {
  it('guarda status, código y mensaje', () => {
    const e = new HttpError(409, 'conflict', 'ya existe');
    expect(e).toBeInstanceOf(Error);
    expect([e.status, e.code, e.message]).toEqual([409, 'conflict', 'ya existe']);
  });

  it.each([200, 399, 600, 0, -1, 404.5, Number.NaN])(
    'un status inválido (%s) se vuelve 500',
    (st) => {
      expect(new HttpError(st, 'x').status).toBe(500);
    },
  );

  it.each([400, 404, 409, 500, 599])('conserva el status válido %s', (st) => {
    expect(new HttpError(st, 'x').status).toBe(st);
  });

  it('usa el código como mensaje por defecto', () => {
    expect(new HttpError(404, 'not_found').message).toBe('not_found');
  });
});

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { validationErrorResponse } from './validation';

const esquema = z.strictObject({
  a: z.string({ error: 'a debe ser texto' }),
  anidado: z.strictObject({ lista: z.array(z.number({ error: 'debe ser número' })) }),
});

function falla(entrada: unknown) {
  const r = esquema.safeParse(entrada);
  if (r.success) throw new Error('se esperaba fallo');
  return validationErrorResponse(r.error);
}

describe('validationErrorResponse', () => {
  it('devuelve 422 validation_error con rutas y mensajes, sin eco de valores', () => {
    const res = falla({ a: 1, anidado: { lista: [1, 'secreto-123'] } });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body as string);
    expect(body.error).toBe('validation_error');
    expect(body.issues).toEqual(
      expect.arrayContaining([
        { path: 'a', message: 'a debe ser texto' },
        { path: 'anidado.lista[1]', message: 'debe ser número' },
      ]),
    );
    expect(res.body).not.toContain('secreto-123');
  });

  it('no refleja los nombres de campos extra enviados por el cliente', () => {
    const res = falla({ a: 'x', anidado: { lista: [] }, '<script>': 1 });
    expect(res.body).not.toContain('script');
    expect(JSON.parse(res.body as string).issues[0].message).toBe(
      'El cuerpo incluye campos no permitidos',
    );
  });

  it('un cuerpo que no es objeto da un mensaje genérico', () => {
    const res = falla('hola');
    expect(JSON.parse(res.body as string).issues).toEqual([
      { path: '', message: 'El cuerpo debe ser un objeto JSON' },
    ]);
  });
});

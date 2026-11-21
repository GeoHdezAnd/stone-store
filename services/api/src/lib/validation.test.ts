import { describe, expect, it } from 'vitest';
import { createQuoteRequestSchema } from '@canteras/shared';
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

describe('validationErrorResponse: mensajes de zod en inglés', () => {
  const profundo = (n: number): unknown => JSON.parse('['.repeat(n) + ']'.repeat(n));
  const INGLES = /Invalid|expected|received|Too (?:big|small)|Unrecognized|Input/;

  it('un objeto anidado que llega como arreglo (5 000 niveles) da un mensaje en español', () => {
    const res = falla({ a: 'x', anidado: profundo(5000) });
    expect(res.statusCode).toBe(422);
    const { issues } = JSON.parse(res.body as string) as {
      issues: { path: string; message: string }[];
    };
    expect(issues.length).toBeGreaterThan(0);
    for (const i of issues) expect(i.message, i.path).not.toMatch(INGLES);
    expect(issues[0]!.path).toBe('anidado');
    expect(res.body).not.toMatch(INGLES);
  });

  it('un campo obligatorio ausente dentro de un objeto también sale en español', () => {
    const res = falla({ a: 'x', anidado: {} });
    expect(res.body).not.toMatch(INGLES);
  });

  it('el cuerpo real de POST /quotes con arreglos profundos en todos los campos sale en español', () => {
    const r = createQuoteRequestSchema.safeParse({
      customer: profundo(5000),
      works: profundo(5000),
      items: [profundo(5000)],
      consent: profundo(5000),
    });
    if (r.success) throw new Error('se esperaba fallo');
    const res = validationErrorResponse(r.error);
    expect(res.body).not.toMatch(INGLES);
  });
});

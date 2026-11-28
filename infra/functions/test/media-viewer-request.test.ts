import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

import { describe, expect, it } from 'vitest';

// La CloudFront Function es JS puro (cloudfront-js-2.0, sin módulos): se evalúa en un contexto
// aislado de `node:vm`, igual que la ejecuta CloudFront (sin require, sin process).
const source = readFileSync(join(import.meta.dirname, '..', 'media-viewer-request.js'), 'utf8');

interface Request {
  method: string;
  uri: string;
  querystring: Record<string, { value: string }>;
  headers: Record<string, unknown>;
}
type Handler = (event: { request: Request }) => Request | { statusCode: number };

function load(): Handler {
  const ctx: { handler?: Handler } = {};
  vm.runInNewContext(`${source};this.handler=handler;`, ctx);
  return ctx.handler!;
}
const handler = load();

const run = (uri: string, method = 'GET'): ReturnType<Handler> =>
  handler({ request: { method, uri, querystring: { a: { value: '1' } }, headers: {} } });

const U = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('media-viewer-request: lo que SÍ deja pasar', () => {
  it.each([
    [`/media/stones/arenisca/${U}-480w.webp`, `/stones/arenisca/${U}-480w.webp`],
    [`/media/projects/casa-x/${U}-1600w.webp`, `/projects/casa-x/${U}-1600w.webp`],
    [`/media/finishes/cincelado/${U}-960w.webp`, `/finishes/cincelado/${U}-960w.webp`],
    [`/media/stones/a1-b2-c3/${U}-960w.webp`, `/stones/a1-b2-c3/${U}-960w.webp`],
  ])('reescribe %s quitando /media y vacía la query', (uri, esperado) => {
    const r = run(uri) as Request;
    expect(r.uri).toBe(esperado);
    expect(r.querystring).toEqual({});
  });

  it('acepta HEAD', () => {
    const r = run(`/media/stones/arenisca/${U}-480w.webp`, 'HEAD') as Request;
    expect(r.uri).toBe(`/stones/arenisca/${U}-480w.webp`);
  });

  it('acepta el id de 64 caracteres (máximo del dominio) y queda bajo el tope de longitud', () => {
    const id = 'a'.repeat(64);
    const uri = `/media/stones/${id}/${U}-480w.webp`;
    expect(uri.length).toBeLessThanOrEqual(260);
    expect((run(uri) as Request).uri).toBe(`/stones/${id}/${U}-480w.webp`);
  });
});

describe('media-viewer-request: lo que NO deja pasar (404)', () => {
  const notFound = (uri: string, method = 'GET'): void => {
    const r = run(uri, method) as { statusCode?: number; uri?: string };
    expect(r.statusCode, `debió dar 404: ${uri}`).toBe(404);
  };

  it.each([
    ['el original .jpg', `/media/stones/arenisca/${U}.jpg`],
    ['el original .png', `/media/stones/arenisca/${U}.png`],
    ['el original .webp sin ancho', `/media/stones/arenisca/${U}.webp`],
    ['ancho falso 481', `/media/stones/arenisca/${U}-481w.webp`],
    ['ancho falso 100', `/media/stones/arenisca/${U}-100w.webp`],
    ['ancho 4800', `/media/stones/arenisca/${U}-4800w.webp`],
    ['ancho 16000', `/media/stones/arenisca/${U}-16000w.webp`],
    ['recorrido ..', `/media/stones/../arenisca/${U}-480w.webp`],
    ['recorrido ..  al inicio', `/media/../stones/arenisca/${U}-480w.webp`],
    ['recorrido codificado %2e%2e', `/media/stones/arenisca/%2e%2e/${U}-480w.webp`],
    ['punto codificado %2e', `/media/stones/%2earenisca/${U}-480w.webp`],
    ['barra doble', `/media//stones/arenisca/${U}-480w.webp`],
    ['barra doble intermedia', `/media/stones//arenisca/${U}-480w.webp`],
    ['entidad en mayúsculas', `/media/Stones/arenisca/${U}-480w.webp`],
    ['id en mayúsculas', `/media/stones/Arenisca/${U}-480w.webp`],
    ['uuid en mayúsculas', `/media/stones/arenisca/${U.toUpperCase()}-480w.webp`],
    ['extensión en mayúsculas', `/media/stones/arenisca/${U}-480w.WEBP`],
    ['otra entidad', `/media/other/arenisca/${U}-480w.webp`],
    ['entidad users', `/media/users/arenisca/${U}-480w.webp`],
    ['barra final', `/media/stones/arenisca/${U}-480w.webp/`],
    ['byte nulo codificado', `/media/stones/arenisca/${U}-480w.webp%00`],
    ['byte nulo literal', `/media/stones/arenisca/${U}-480w.webp\u0000`],
    ['salto de línea', `/media/stones/arenisca/${U}-480w.webp\n`],
    ['guiones dobles en el id', `/media/stones/a--b/${U}-480w.webp`],
    ['guion al inicio del id', `/media/stones/-ab/${U}-480w.webp`],
    ['guion al final del id', `/media/stones/ab-/${U}-480w.webp`],
    ['carpeta extra', `/media/stones/arenisca/x/${U}-480w.webp`],
    ['sin carpeta de id', `/media/stones/${U}-480w.webp`],
    ['nombre que no es uuid', '/media/stones/arenisca/foto-480w.webp'],
    ['uuid v1 (no v4)', `/media/stones/arenisca/0f8fad5b-d9cb-169f-a165-70867728950e-480w.webp`],
    [
      'uuid con variante inválida',
      `/media/stones/arenisca/0f8fad5b-d9cb-469f-c165-70867728950e-480w.webp`,
    ],
    ['uuid truncado', `/media/stones/arenisca/0f8fad5b-d9cb-469f-a165-70867728950-480w.webp`],
    ['prefijo anclado: texto antes de /media', `/x/media/stones/arenisca/${U}-480w.webp`],
    ['sin prefijo /media', `/stones/arenisca/${U}-480w.webp`],
    ['solo /media/', '/media/'],
    ['vacío', ''],
    ['raíz', '/'],
    ['otra ruta publicada', '/published/catalog.json'],
  ])('%s', (_nombre, uri) => {
    notFound(uri);
  });

  it.each(['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'get'])('rechaza el método %s', (m) => {
    notFound(`/media/stones/arenisca/${U}-480w.webp`, m);
  });

  it('responde 404 con descripción y sin tocar la solicitud', () => {
    const r = run(`/media/stones/arenisca/${U}.jpg`) as {
      statusCode: number;
      statusDescription: string;
    };
    expect(r.statusCode).toBe(404);
    expect(r.statusDescription).toBe('Not Found');
  });
});

describe('media-viewer-request: límite de longitud (260)', () => {
  // `/media/stones/<id>/<uuid>-480w.webp` mide 15 + id + 1 + 36 + 10 = id + 62... se calcula abajo.
  const base = (id: string): string => `/media/stones/${id}/${U}-480w.webp`;

  it('un uri válido de exactamente 260 caracteres pasa', () => {
    // La regex del dominio no limita el id a 64; el tope de 260 es la defensa extra de la función.
    const fill = 260 - base('x').length + 1;
    const uri = base('x'.repeat(fill));
    expect(uri.length).toBe(260);
    expect((run(uri) as Request).uri).toBe(uri.slice(6));
  });

  it('con 261 caracteres responde 404 aunque calce la forma', () => {
    const uri = base('x'.repeat(260 - base('x').length + 2));
    expect(uri.length).toBe(261);
    expect((run(uri) as { statusCode?: number }).statusCode).toBe(404);
  });
});

describe('media-viewer-request: es JS puro compatible con CloudFront Functions', () => {
  it('no usa require, import, export ni process', () => {
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/^\s*(import|export)\s/m);
    expect(source).not.toMatch(/\bprocess\./);
  });

  it('se evalúa en un contexto vacío (sin globales de Node)', () => {
    expect(() => load()).not.toThrow();
  });
});

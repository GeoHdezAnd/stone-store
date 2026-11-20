import { describe, expect, it } from 'vitest';
import {
  buildCatalogDocument,
  canonicalJson,
  catalogDocumentSchema,
  CATALOG_VERSION_PATTERN,
  type CatalogDocumentInput,
} from './document';
import type { Finish } from './finish';
import type { Project } from './project';
import type { Service } from './service';
import type { PublicSettings } from './settings';
import type { Stone } from './stone';

// Hash de PRUEBA (FNV-1a de 32 bits repetido a 64 hex): shared no puede usar node:crypto; en
// producción lo inyecta el servicio con sha-256.
function fakeHash(texto: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < texto.length; i++) {
    h ^= texto.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0').repeat(8);
}

const stone = (over: Record<string, unknown> = {}): Stone =>
  ({
    id: 'arenisca',
    nombre: 'Arenisca',
    origen: 'Sedimentaria',
    tipoRoca: 'Roca sedimentaria',
    colores: ['Beige'],
    categoriasUso: ['fachadas'],
    acabados: ['Labrado'],
    formatos: ['Bloque'],
    espesoresCm: [5],
    absorcionPct: 4.2,
    descripcion: '',
    existencia: 'En patio',
    entregaDias: 7,
    vendidaPor: ['m2'],
    pesoKgPorM2PorCm: null,
    pesoKgPorPieza: null,
    densidadKgM3: 2200,
    fotos: [],
    proyectosRelacionados: [],
    activa: true,
    ...over,
  }) as Stone;

const project = (over: Record<string, unknown> = {}): Project =>
  ({
    id: 'casa',
    titulo: 'Casa',
    categoria: 'fachadas',
    ubicacion: 'Puebla',
    anio: 2024,
    descripcion: '',
    superficie: '',
    piedras: [],
    acabados: [],
    piezasLabradas: null,
    entrega: '',
    testimonio: null,
    fotos: [],
    estado: 'publicado',
    activa: true,
    ...over,
  }) as Project;

const finish = (over: Record<string, unknown> = {}): Finish =>
  ({
    id: 'apomazado',
    nombre: 'Apomazado',
    descripcion: '',
    foto: null,
    activa: true,
    ...over,
  }) as Finish;

const service = (over: Record<string, unknown> = {}): Service =>
  ({ id: 'bruto', titulo: 'Bruto', descripcion: '', activa: true, ...over }) as Service;

const settings: PublicSettings = {
  nombrePatio: 'Patio',
  direccion: 'Calle 1',
  lat: 19.1,
  lng: -97.6,
  horario: '8 a 17',
  whatsapp: '525512345678',
  correoRemitente: 'ventas@ejemplo.test',
};

function input(over: Partial<CatalogDocumentInput> = {}): CatalogDocumentInput {
  return {
    stones: [],
    finishes: [],
    projects: [],
    services: [],
    publicSettings: settings,
    version: 'v0001',
    generatedAt: '2026-11-19T10:00:00.000Z',
    ...over,
  };
}

const build = (over: Partial<CatalogDocumentInput> = {}) =>
  buildCatalogDocument(input(over), fakeHash);

describe('buildCatalogDocument: filtros', () => {
  it('incluye solo registros activos', () => {
    const doc = build({
      stones: [stone({ id: 'a' }), stone({ id: 'b', activa: false })],
      finishes: [finish({ id: 'f1' }), finish({ id: 'f2', activa: false })],
      services: [service({ id: 's1' }), service({ id: 's2', activa: false })],
      projects: [project({ id: 'p1' }), project({ id: 'p2', activa: false })],
    });
    expect(doc.stones.map((s) => s.id)).toEqual(['a']);
    expect(doc.finishes.map((s) => s.id)).toEqual(['f1']);
    expect(doc.services.map((s) => s.id)).toEqual(['s1']);
    expect(doc.projects.map((s) => s.id)).toEqual(['p1']);
  });

  it('excluye los proyectos en borrador', () => {
    const doc = build({
      projects: [project({ id: 'p1' }), project({ id: 'p2', estado: 'borrador' })],
    });
    expect(doc.projects.map((p) => p.id)).toEqual(['p1']);
  });
});

describe('buildCatalogDocument: referencias', () => {
  it('quita de stone.proyectosRelacionados los proyectos en borrador, inactivos o inexistentes', () => {
    const doc = build({
      stones: [stone({ proyectosRelacionados: ['ok', 'borrador', 'inactivo', 'no-existe'] })],
      projects: [
        project({ id: 'ok' }),
        project({ id: 'borrador', estado: 'borrador' }),
        project({ id: 'inactivo', activa: false }),
      ],
    });
    expect(doc.stones[0]?.proyectosRelacionados).toEqual(['ok']);
  });

  it('quita de project.piedras y project.acabados los registros inactivos o inexistentes', () => {
    const doc = build({
      stones: [stone({ id: 'viva' }), stone({ id: 'muerta', activa: false })],
      finishes: [finish({ id: 'f-viva' }), finish({ id: 'f-muerta', activa: false })],
      projects: [
        project({
          id: 'p',
          piedras: ['viva', 'muerta', 'no-existe'],
          acabados: ['f-viva', 'f-muerta', 'no-existe'],
        }),
      ],
    });
    expect(doc.projects[0]?.piedras).toEqual(['viva']);
    expect(doc.projects[0]?.acabados).toEqual(['f-viva']);
  });

  it('conserva el orden original de las referencias', () => {
    const doc = build({
      stones: [stone({ id: 'b' }), stone({ id: 'a' })],
      projects: [project({ id: 'p', piedras: ['b', 'a'] })],
    });
    expect(doc.projects[0]?.piedras).toEqual(['b', 'a']);
  });

  it('no muta las entradas', () => {
    const s = stone({ proyectosRelacionados: ['borrador'] });
    const entrada = input({
      stones: [s],
      projects: [project({ id: 'borrador', estado: 'borrador' })],
    });
    const copia = JSON.parse(JSON.stringify(entrada)) as typeof entrada;
    buildCatalogDocument(entrada, fakeHash);
    expect(entrada).toEqual(copia);
  });
});

describe('buildCatalogDocument: orden y hash', () => {
  it('ordena cada lista por id', () => {
    const doc = build({
      stones: [stone({ id: 'c' }), stone({ id: 'a' }), stone({ id: 'b' })],
      services: [service({ id: 'z' }), service({ id: 'y' })],
    });
    expect(doc.stones.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(doc.services.map((s) => s.id)).toEqual(['y', 'z']);
  });

  it('dos ejecuciones idénticas dan el mismo hash, aun con otro orden de entrada', () => {
    const a = build({ stones: [stone({ id: 'a' }), stone({ id: 'b' })] });
    const b = build({ stones: [stone({ id: 'b' }), stone({ id: 'a' })] });
    expect(a.hash).toBe(b.hash);
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('el hash no depende de version ni generatedAt', () => {
    const a = build({ version: 'v0001', generatedAt: '2026-01-01T00:00:00.000Z' });
    const b = build({ version: 'v0099', generatedAt: '2027-01-01T00:00:00.000Z' });
    expect(a.hash).toBe(b.hash);
    expect(a.version).not.toBe(b.version);
  });

  it('el hash cambia si cambia el contenido publicado', () => {
    const base = build({ stones: [stone()] });
    expect(build({ stones: [stone({ nombre: 'Otra' })] }).hash).not.toBe(base.hash);
    expect(build({ publicSettings: { ...settings, horario: 'otro' } }).hash).not.toBe(build().hash);
  });

  it('el hash no cambia por registros que no se publican', () => {
    const base = build({ stones: [stone()] });
    const conExtras = build({
      stones: [stone(), stone({ id: 'oculta', activa: false })],
      projects: [project({ estado: 'borrador' })],
    });
    expect(conExtras.hash).toBe(base.hash);
  });
});

describe('buildCatalogDocument: configuración', () => {
  it('incluye solo la fila pública y rechaza campos de la fila MAIL', () => {
    const doc = build();
    expect(doc.settings).toEqual(settings);
    const conMail = {
      ...settings,
      plantillaCotizacion: 'secreto',
      asuntoCotizacion: 'secreto',
    } as unknown as PublicSettings;
    expect(() => build({ publicSettings: conMail })).toThrow();
  });

  it('el documento resultante cumple el esquema', () => {
    const doc = build({ stones: [stone()], projects: [project()], finishes: [finish()] });
    expect(catalogDocumentSchema.safeParse(doc).success).toBe(true);
    expect(doc.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('el esquema rechaza campos de más (strictObject) y versiones mal formadas', () => {
    const doc = build();
    expect(catalogDocumentSchema.safeParse({ ...doc, extra: 1 }).success).toBe(false);
    expect(catalogDocumentSchema.safeParse({ ...doc, version: 'CURRENT' }).success).toBe(false);
    expect(CATALOG_VERSION_PATTERN.test('v0001')).toBe(true);
    expect(CATALOG_VERSION_PATTERN.test('v1')).toBe(false);
    expect(CATALOG_VERSION_PATTERN.test('v00012')).toBe(true);
  });

  it('rechaza una función de hash que no devuelve sha-256 en hexadecimal', () => {
    expect(() => buildCatalogDocument(input(), () => 'corto')).toThrow();
  });
});

describe('canonicalJson', () => {
  it('ordena las claves de forma recursiva y no depende del orden de inserción', () => {
    expect(canonicalJson({ b: 1, a: { d: 1, c: [{ z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[{"y":2,"z":1}],"d":1},"b":1}',
    );
  });

  it('omite undefined y conserva null y el orden de los arreglos', () => {
    expect(canonicalJson({ a: undefined, b: null, c: [2, 1] })).toBe('{"b":null,"c":[2,1]}');
  });
});

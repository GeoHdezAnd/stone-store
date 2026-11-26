import { describe, expect, it } from 'vitest';
import { MAX_ITEMS } from '../weight';
import { freightSimulateRequestSchema, parseFreightSimulateRequest } from '../request';

const item = { stoneId: 'arenisca', cantidad: 10, unidad: 'm2', espesorCm: 5 };
const valido = { distanciaKm: 62, codigoPostal: '74000', items: [item] };

function errores(r: { ok: boolean; errors?: string[] }): string[] {
  expect(r.ok).toBe(false);
  return r.errors ?? [];
}

describe('renglones y cuerpo (itemsSchema, compartido vía el simulador)', () => {
  it('acepta una solicitud válida (espesorCm opcional)', () => {
    const r = parseFreightSimulateRequest(valido);
    expect(r).toEqual({ ok: true, data: valido });
    expect(
      parseFreightSimulateRequest({
        distanciaKm: 1,
        codigoPostal: '74000',
        items: [{ stoneId: 'a', cantidad: 1, unidad: 'tonelada' }],
      }).ok,
    ).toBe(true);
  });

  it('conserva __proto__ como clave propia: se rechaza como campo no permitido', () => {
    const hostil = JSON.parse(
      '{"distanciaKm":1,"codigoPostal":"74000","items":[{"stoneId":"a","cantidad":1,"unidad":"pieza"}],"__proto__":{"admin":true}}',
    );
    expect(errores(parseFreightSimulateRequest(hostil)).length).toBeGreaterThan(0);
    const enItem = JSON.parse(
      '{"distanciaKm":1,"codigoPostal":"74000","items":[{"stoneId":"a","cantidad":1,"unidad":"pieza","__proto__":{"x":1}}]}',
    );
    expect(parseFreightSimulateRequest(enItem).ok).toBe(false);
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['texto', 'hola'],
    ['número', 42],
    ['arreglo', []],
    ['items: [null]', { ...valido, items: [null] }],
    ['items: {}', { ...valido, items: {} }],
    ['items: "x"', { ...valido, items: 'x' }],
    ['sin items', { distanciaKm: 62, codigoPostal: '74000' }],
    ['items vacío', { ...valido, items: [] }],
    ['demasiados items', { ...valido, items: Array.from({ length: MAX_ITEMS + 1 }, () => item) }],
    ['codigoPostal numérico', { ...valido, codigoPostal: 74000 }],
    ['codigoPostal corto', { ...valido, codigoPostal: '7400' }],
    ['codigoPostal con espacios', { ...valido, codigoPostal: ' 74000' }],
    ['codigoPostal con salto de línea', { ...valido, codigoPostal: '74000\n' }],
    ['sin distanciaKm', { codigoPostal: '74000', items: [item] }],
    ['peso que manda el cliente (pesoKg)', { ...valido, items: [{ ...item, pesoKg: 1 }] }],
    ['peso en la raíz', { ...valido, pesoKg: 1 }],
    ['campo extra', { ...valido, extra: 1 }],
    ['campo extra en item', { ...valido, items: [{ ...item, peso: 1 }] }],
    ['cantidad 0', { ...valido, items: [{ ...item, cantidad: 0 }] }],
    ['cantidad negativa', { ...valido, items: [{ ...item, cantidad: -1 }] }],
    ['cantidad NaN', { ...valido, items: [{ ...item, cantidad: Number.NaN }] }],
    ['cantidad Infinity', { ...valido, items: [{ ...item, cantidad: Number.POSITIVE_INFINITY }] }],
    ['cantidad texto', { ...valido, items: [{ ...item, cantidad: '10' }] }],
    ['unidad inválida', { ...valido, items: [{ ...item, unidad: 'litro' }] }],
    ['stoneId vacío', { ...valido, items: [{ ...item, stoneId: '' }] }],
    ['stoneId número', { ...valido, items: [{ ...item, stoneId: 5 }] }],
    ['espesorCm texto', { ...valido, items: [{ ...item, espesorCm: '5' }] }],
    ['espesorCm NaN', { ...valido, items: [{ ...item, espesorCm: Number.NaN }] }],
  ])('entrada hostil o inválida (%s) → errores de validación, nunca excepción', (_n, entrada) => {
    let r: ReturnType<typeof parseFreightSimulateRequest> | undefined;
    expect(() => {
      r = parseFreightSimulateRequest(entrada);
    }).not.toThrow();
    const msgs = errores(r!);
    expect(msgs.length).toBeGreaterThan(0);
    for (const m of msgs) {
      expect(m).not.toMatch(/\b(Invalid|expected|received|Unrecognized|Required)\b/);
    }
  });

  it('el tope de items es MAX_ITEMS', () => {
    expect(
      parseFreightSimulateRequest({
        ...valido,
        items: Array.from({ length: MAX_ITEMS }, () => item),
      }).ok,
    ).toBe(true);
  });
});

describe('parseFreightSimulateRequest', () => {
  it('exige distanciaKm finita >= 0 y acepta codigoPostal opcional', () => {
    expect(parseFreightSimulateRequest({ distanciaKm: 62, items: [item] }).ok).toBe(true);
    expect(
      parseFreightSimulateRequest({ distanciaKm: 0, codigoPostal: '74000', items: [item] }).ok,
    ).toBe(true);
    for (const d of [-1, Number.NaN, Number.POSITIVE_INFINITY, '62', undefined, null]) {
      expect(parseFreightSimulateRequest({ distanciaKm: d, items: [item] }).ok).toBe(false);
    }
    expect(parseFreightSimulateRequest({ items: [item] }).ok).toBe(false);
  });

  it('si trae codigoPostal, valida el formato; rechaza campos extra', () => {
    expect(
      parseFreightSimulateRequest({ distanciaKm: 5, codigoPostal: '7400', items: [item] }).ok,
    ).toBe(false);
    expect(
      parseFreightSimulateRequest({ distanciaKm: 5, codigoPostal: 74000, items: [item] }).ok,
    ).toBe(false);
    expect(
      parseFreightSimulateRequest({ distanciaKm: 5, items: [item], skipZoneCheck: true }).ok,
    ).toBe(false);
    expect(freightSimulateRequestSchema.safeParse({ distanciaKm: 5, items: [item] }).success).toBe(
      true,
    );
  });

  it('entradas hostiles no lanzan', () => {
    for (const x of [
      null,
      undefined,
      'x',
      [],
      { items: [null], distanciaKm: 1 },
      { items: {}, distanciaKm: 1 },
    ]) {
      expect(() => parseFreightSimulateRequest(x)).not.toThrow();
      expect(parseFreightSimulateRequest(x).ok).toBe(false);
    }
  });
});

describe('mensajes de objeto inválido (concordancia de género)', () => {
  it('«La solicitud no es válida» para cuerpos que no son objeto', () => {
    for (const raw of [null, [], 'x', 3]) {
      expect(errores(parseFreightSimulateRequest(raw))).toEqual(['La solicitud no es válida']);
    }
  });

  it('«Cada renglón no es válido» para un renglón que no es objeto', () => {
    expect(errores(parseFreightSimulateRequest({ ...valido, items: ['x'] }))).toEqual([
      'Cada renglón no es válido',
    ]);
  });
});

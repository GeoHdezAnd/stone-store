import { describe, expect, it } from 'vitest';
import { MAX_ITEMS, MAX_ITEM_QUANTITY } from '../freight/weight';
import { createQuoteRequestSchema } from './create-request';

// Datos de EJEMPLO.
function valid(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    customer: { nombre: 'María Pérez', telefono: '555-0101', correo: 'maria@example.com' },
    works: {
      lugar: 'San Andrés Cholula',
      codigoPostal: '72810',
      uso: 'Fachada',
      notas: 'Preferimos entrega en la mañana.',
    },
    items: [
      { stoneId: 'arenisca', acabado: 'Labrado', cantidad: 10.5, unidad: 'm2', espesorCm: 5 },
      { stoneId: 'caliza', cantidad: 3, unidad: 'pieza' },
    ],
    consent: true,
    website: '',
    turnstileToken: 'token-de-ejemplo',
    ...over,
  };
}

const messages = (raw: unknown): string[] => {
  const r = createQuoteRequestSchema.safeParse(raw);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};
const paths = (raw: unknown): string[] => {
  const r = createQuoteRequestSchema.safeParse(raw);
  return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
};

describe('createQuoteRequestSchema: casos válidos', () => {
  it('acepta una solicitud completa', () => {
    const r = createQuoteRequestSchema.safeParse(valid());
    expect(r.success).toBe(true);
  });

  it('el acabado puede faltar o ir vacío y el honeypot puede faltar', () => {
    const sinHoneypot = valid();
    delete sinHoneypot['website'];
    expect(createQuoteRequestSchema.safeParse(sinHoneypot).success).toBe(true);
    const items = [{ stoneId: 'caliza', acabado: '', cantidad: 1, unidad: 'tonelada' }];
    expect(createQuoteRequestSchema.safeParse(valid({ items })).success).toBe(true);
  });

  it('uso y notas pueden ir vacíos', () => {
    const w = { lugar: 'Puebla', codigoPostal: '72000', uso: '', notas: '' };
    expect(createQuoteRequestSchema.safeParse(valid({ works: w })).success).toBe(true);
  });

  it('recorta espacios en los textos', () => {
    const r = createQuoteRequestSchema.parse(
      valid({
        customer: { nombre: '  María  ', telefono: ' 555-0101 ', correo: 'maria@example.com' },
      }),
    );
    expect(r.customer.nombre).toBe('María');
    expect(r.customer.telefono).toBe('555-0101');
  });

  it('un honeypot lleno NO es un error de validación (lo decide el handler)', () => {
    const r = createQuoteRequestSchema.safeParse(valid({ website: 'http://spam.example' }));
    expect(r.success).toBe(true);
    expect(r.success && r.data.website).toBe('http://spam.example');
  });

  it('admite el máximo de piedras y las cantidades límite', () => {
    const items = Array.from({ length: MAX_ITEMS }, (_, i) => ({
      stoneId: `piedra-${i}`,
      cantidad: MAX_ITEM_QUANTITY,
      unidad: 'tonelada',
    }));
    expect(createQuoteRequestSchema.safeParse(valid({ items })).success).toBe(true);
    const minima = [{ stoneId: 'caliza', cantidad: 0.01, unidad: 'tonelada' }];
    expect(createQuoteRequestSchema.safeParse(valid({ items: minima })).success).toBe(true);
  });
});

describe('createQuoteRequestSchema: consentimiento y captcha', () => {
  it.each([false, undefined, 'true', 1, null])('rechaza consent = %s', (consent) => {
    const raw = valid();
    if (consent === undefined) delete raw['consent'];
    else raw['consent'] = consent;
    expect(paths(raw)).toContain('consent');
    expect(messages(raw).join(' ')).toMatch(/aviso de privacidad/i);
  });

  it.each([undefined, '', 5, 'x'.repeat(2049)])('rechaza turnstileToken = %s', (tok) => {
    const raw = valid();
    if (tok === undefined) delete raw['turnstileToken'];
    else raw['turnstileToken'] = typeof tok === 'string' ? tok : tok;
    expect(paths(raw)).toContain('turnstileToken');
  });

  it('acepta un token de exactamente 2048 caracteres', () => {
    expect(
      createQuoteRequestSchema.safeParse(valid({ turnstileToken: 'x'.repeat(2048) })).success,
    ).toBe(true);
  });

  it('el honeypot debe ser texto si viene', () => {
    expect(paths(valid({ website: 5 }))).toContain('website');
  });
});

describe('createQuoteRequestSchema: cliente', () => {
  it.each([
    ['nombre vacío', { nombre: '', telefono: '555-0101', correo: 'a@example.com' }, 'nombre'],
    [
      'nombre solo espacios',
      { nombre: '   ', telefono: '555-0101', correo: 'a@example.com' },
      'nombre',
    ],
    [
      'nombre de 121',
      { nombre: 'a'.repeat(121), telefono: '555-0101', correo: 'a@example.com' },
      'nombre',
    ],
    [
      'nombre con salto de línea',
      { nombre: 'Ana\nBcc: x', telefono: '555-0101', correo: 'a@example.com' },
      'nombre',
    ],
    [
      'nombre con carácter de dirección',
      { nombre: 'Ana‮oz', telefono: '555-0101', correo: 'a@example.com' },
      'nombre',
    ],
    ['teléfono corto', { nombre: 'Ana', telefono: '1234', correo: 'a@example.com' }, 'telefono'],
    [
      'teléfono largo',
      { nombre: 'Ana', telefono: '1'.repeat(31), correo: 'a@example.com' },
      'telefono',
    ],
    [
      'teléfono con salto de línea',
      { nombre: 'Ana', telefono: '555\n0101', correo: 'a@example.com' },
      'telefono',
    ],
    ['correo inválido', { nombre: 'Ana', telefono: '555-0101', correo: 'no-es-correo' }, 'correo'],
    [
      'correo con coma (dos destinatarios)',
      { nombre: 'Ana', telefono: '555-0101', correo: 'a@example.com,b@example.com' },
      'correo',
    ],
    [
      'correo con espacio',
      { nombre: 'Ana', telefono: '555-0101', correo: 'a b@example.com' },
      'correo',
    ],
    [
      'correo de 255',
      { nombre: 'Ana', telefono: '555-0101', correo: `${'a'.repeat(250)}@e.mx` },
      'correo',
    ],
  ])('rechaza %s', (_n, customer, campo) => {
    expect(paths(valid({ customer }))).toContain(`customer.${campo}`);
  });

  it('rechaza campos extra en customer', () => {
    const customer = { nombre: 'Ana', telefono: '555-0101', correo: 'a@example.com', rol: 'owner' };
    expect(createQuoteRequestSchema.safeParse(valid({ customer })).success).toBe(false);
  });
});

describe('createQuoteRequestSchema: obra', () => {
  it.each([
    ['lugar vacío', { lugar: '', codigoPostal: '72810', uso: '', notas: '' }, 'lugar'],
    [
      'lugar de 201',
      { lugar: 'a'.repeat(201), codigoPostal: '72810', uso: '', notas: '' },
      'lugar',
    ],
    ['CP de 4 dígitos', { lugar: 'x', codigoPostal: '7281', uso: '', notas: '' }, 'codigoPostal'],
    ['CP con letras', { lugar: 'x', codigoPostal: '7281a', uso: '', notas: '' }, 'codigoPostal'],
    ['CP de 6 dígitos', { lugar: 'x', codigoPostal: '728100', uso: '', notas: '' }, 'codigoPostal'],
    ['uso de 201', { lugar: 'x', codigoPostal: '72810', uso: 'a'.repeat(201), notas: '' }, 'uso'],
    [
      'notas de 2001',
      { lugar: 'x', codigoPostal: '72810', uso: '', notas: 'a'.repeat(2001) },
      'notas',
    ],
    [
      'notas con carácter de control',
      { lugar: 'x', codigoPostal: '72810', uso: '', notas: 'a\u0000b' },
      'notas',
    ],
  ])('rechaza %s', (_n, works, campo) => {
    expect(paths(valid({ works }))).toContain(`works.${campo}`);
  });

  it('las notas admiten saltos de línea y tabulaciones', () => {
    const works = { lugar: 'x', codigoPostal: '72810', uso: '', notas: 'línea 1\r\nlínea 2\tfin' };
    expect(createQuoteRequestSchema.safeParse(valid({ works })).success).toBe(true);
  });

  it('el lugar no admite saltos de línea', () => {
    const works = { lugar: 'a\nb', codigoPostal: '72810', uso: '', notas: '' };
    expect(paths(valid({ works }))).toContain('works.lugar');
  });
});

describe('createQuoteRequestSchema: piedras', () => {
  const item = { stoneId: 'caliza', cantidad: 1, unidad: 'tonelada' };

  it('exige al menos una piedra y como máximo MAX_ITEMS', () => {
    expect(paths(valid({ items: [] }))).toContain('items');
    const mucho = Array.from({ length: MAX_ITEMS + 1 }, (_, i) => ({ ...item, stoneId: `p-${i}` }));
    expect(paths(valid({ items: mucho }))).toContain('items');
  });

  it('rechaza piedras repetidas', () => {
    expect(messages(valid({ items: [item, item] })).join(' ')).toMatch(/repetir/i);
  });

  it.each([
    ['stoneId vacío', { ...item, stoneId: '' }],
    ['stoneId con mayúsculas', { ...item, stoneId: 'Caliza' }],
    ['stoneId con ..', { ...item, stoneId: '../x' }],
    ['stoneId de 65', { ...item, stoneId: 'a'.repeat(65) }],
    ['cantidad 0', { ...item, cantidad: 0 }],
    ['cantidad negativa', { ...item, cantidad: -1 }],
    ['cantidad por debajo del mínimo', { ...item, cantidad: 0.001 }],
    ['cantidad sobre el tope', { ...item, cantidad: MAX_ITEM_QUANTITY + 1 }],
    ['cantidad NaN como texto', { ...item, cantidad: '3' }],
    ['unidad inválida', { ...item, unidad: 'kilo' }],
    ['acabado de 81', { ...item, acabado: 'a'.repeat(81) }],
    ['m2 sin espesor', { stoneId: 'arenisca', cantidad: 1, unidad: 'm2' }],
    ['espesor 0', { stoneId: 'arenisca', cantidad: 1, unidad: 'm2', espesorCm: 0 }],
    ['espesor en una unidad que no es m2', { ...item, espesorCm: 5 }],
  ])('rechaza %s', (_n, bad) => {
    expect(createQuoteRequestSchema.safeParse(valid({ items: [bad] })).success).toBe(false);
  });
});

describe('createQuoteRequestSchema: sin campos que decide el servidor', () => {
  it.each([
    ['folio', 'CN-2026-00001'],
    ['status', 'ganada'],
    ['quoteId', '01ARZ3NDEKTSV4RRFFQ69G5FAV'],
    ['rev', 99],
    ['freight', {}],
    ['finalQuote', {}],
    ['consentAt', '2026-01-01T00:00:00.000Z'],
    ['createdAt', '2026-01-01T00:00:00.000Z'],
    ['source', {}],
    ['ejemplo', true],
  ])('rechaza el campo %s en la raíz', (campo, valor) => {
    expect(createQuoteRequestSchema.safeParse(valid({ [campo]: valor })).success).toBe(false);
  });

  it.each(['pesoKg', 'precioUnitario', 'nombre', 'subtotal'])(
    'rechaza %s dentro de una piedra',
    (campo) => {
      const items = [{ stoneId: 'caliza', cantidad: 1, unidad: 'tonelada', [campo]: 1 }];
      expect(createQuoteRequestSchema.safeParse(valid({ items })).success).toBe(false);
    },
  );

  it('rechaza __proto__ como propiedad propia (JSON.parse) en la raíz y en objetos anidados', () => {
    const raiz = JSON.parse(
      '{"__proto__":{"consent":true},"customer":{"nombre":"A","telefono":"555-0101","correo":"a@example.com"},"works":{"lugar":"x","codigoPostal":"72810","uso":"","notas":""},"items":[{"stoneId":"caliza","cantidad":1,"unidad":"tonelada"}],"consent":true,"turnstileToken":"t"}',
    );
    expect(createQuoteRequestSchema.safeParse(raiz).success).toBe(false);
    const anidado = JSON.parse(
      '{"customer":{"__proto__":{},"nombre":"A","telefono":"555-0101","correo":"a@example.com"},"works":{"lugar":"x","codigoPostal":"72810","uso":"","notas":""},"items":[{"stoneId":"caliza","cantidad":1,"unidad":"tonelada"}],"consent":true,"turnstileToken":"t"}',
    );
    expect(createQuoteRequestSchema.safeParse(anidado).success).toBe(false);
  });

  it('no contamina el prototipo con un cuerpo hostil', () => {
    createQuoteRequestSchema.safeParse(JSON.parse('{"__proto__":{"polluted":true}}'));
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it.each([null, 5, 'texto', [], undefined])('rechaza un cuerpo que no es objeto (%s)', (raw) => {
    expect(createQuoteRequestSchema.safeParse(raw).success).toBe(false);
  });
});

describe('createQuoteRequestSchema: mensajes', () => {
  it('están en español y no repiten lo enviado', () => {
    const secreto = 'VALOR-SECRETO-12345';
    const raw = valid({
      customer: { nombre: secreto.repeat(10), telefono: secreto, correo: secreto },
      works: { lugar: '', codigoPostal: secreto, uso: secreto.repeat(20), notas: '' },
      items: [{ stoneId: secreto, cantidad: secreto, unidad: secreto }],
      consent: secreto,
      turnstileToken: 5,
    });
    const todos = messages(raw);
    expect(todos.length).toBeGreaterThan(5);
    for (const m of todos) {
      expect(m).not.toContain(secreto);
      expect(m).not.toMatch(/\b(Invalid|Expected|Required)\b/);
    }
  });
});

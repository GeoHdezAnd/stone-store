import { describe, expect, it } from 'vitest';
import { makeStone, stones } from '../freight/test-fixtures';
import { computeWeightKg } from '../freight/weight';
import { createQuoteRequestSchema, type CreateQuoteRequest } from './create-request';
import { buildNewQuote, NewQuoteError, type NewQuoteInput } from './create-quote';
import { quoteSchema, stripStorageKeys } from './schema';
import { quoteIndexKeys } from './search';

const NOW = new Date('2026-11-20T15:30:00.000Z');
const QUOTE_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

function request(over: Record<string, unknown> = {}): CreateQuoteRequest {
  return createQuoteRequestSchema.parse({
    customer: { nombre: 'María Pérez', telefono: '555-0101', correo: 'maria@example.com' },
    works: { lugar: 'San Andrés Cholula', codigoPostal: '72810', uso: 'Fachada', notas: '' },
    items: [
      { stoneId: 'arenisca', acabado: 'Labrado', cantidad: 10, unidad: 'm2', espesorCm: 5 },
      { stoneId: 'caliza', cantidad: 2, unidad: 'tonelada' },
    ],
    consent: true,
    turnstileToken: 'token',
    ...over,
  });
}

function input(over: Partial<NewQuoteInput> = {}): NewQuoteInput {
  return {
    request: request(),
    stones,
    freight: { mermaPct: 5 },
    now: NOW,
    quoteId: QUOTE_ID,
    folio: 'CN-2026-00007',
    source: { userAgent: 'Mozilla/5.0 (X11)', referrer: 'https://sitio.example/contacto' },
    ...over,
  };
}

const [arenisca] = stones;

describe('buildNewQuote: documento', () => {
  it('produce un documento `nueva` que pasa quoteSchema (sin claves de almacenamiento)', () => {
    const { item } = buildNewQuote(input());
    const r = quoteSchema.safeParse(stripStorageKeys(item));
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });

  it('fija los campos de servidor: estado, rev, historial, notas, fechas y folio', () => {
    const { quote } = buildNewQuote(input());
    expect(quote).toMatchObject({
      quoteId: QUOTE_ID,
      folio: 'CN-2026-00007',
      status: 'nueva',
      rev: 1,
      history: [],
      notes: [],
      createdAt: '2026-11-20T15:30:00.000Z',
      consentAt: '2026-11-20T15:30:00.000Z',
    });
    expect(quote.ejemplo).toBeUndefined();
  });

  it('NO trae `freight` (aún no hay distancia), ni finalQuote, ni respondedAt, ni sendLock', () => {
    const { quote } = buildNewQuote(input());
    for (const k of ['freight', 'finalQuote', 'respondedAt', 'sendLock', 'lostReason'] as const) {
      expect(k in quote, k).toBe(false);
    }
  });

  it('copia al cliente y la obra ya recortados', () => {
    const { quote } = buildNewQuote(input());
    expect(quote.customer).toEqual({
      nombre: 'María Pérez',
      telefono: '555-0101',
      correo: 'maria@example.com',
    });
    expect(quote.works).toEqual({
      lugar: 'San Andrés Cholula',
      codigoPostal: '72810',
      uso: 'Fachada',
      notas: '',
    });
  });

  it('agrega las claves de los dos índices y el searchKey con quoteIndexKeys', () => {
    const { item, quote } = buildNewQuote(input());
    expect(item).toMatchObject(quoteIndexKeys(quote));
    expect(item['gsi1pk']).toBe('STATUS#nueva');
    expect(item['gsi2pk']).toBe('QUOTE');
    expect(item['gsi1sk']).toBe(`2026-11-20T15:30:00.000Z#${QUOTE_ID}`);
  });
});

describe('buildNewQuote: piedras (nombre y peso salen del servidor)', () => {
  it('el nombre sale del catálogo y el acabado se conserva si la piedra lo ofrece', () => {
    const { quote } = buildNewQuote(input());
    expect(quote.items[0]).toMatchObject({
      stoneId: 'arenisca',
      nombre: 'Arenisca',
      acabado: 'Labrado',
      cantidad: 10,
      unidad: 'm2',
    });
    expect(quote.items[1]).toMatchObject({ stoneId: 'caliza', nombre: 'Caliza', acabado: '' });
  });

  it('pesoKg = computeWeightKg por piedra, con la merma de la tarifa activa', () => {
    const { quote } = buildNewQuote(input());
    const [a, c] = quote.items;
    const esperadoA = computeWeightKg(
      [{ stoneId: 'arenisca', cantidad: 10, unidad: 'm2', espesorCm: 5 }],
      stones,
      { mermaPct: 5 },
    );
    expect(a!.pesoKg).toBe(esperadoA);
    expect(a!.pesoKg).toBe(1155); // 2200 × 0.05 × 10 × 1.05
    expect(c!.pesoKg).toBe(2100); // 2 t × 1.05
  });

  it('con otra merma cambia el peso (se usa la tarifa activa)', () => {
    const { quote } = buildNewQuote(input({ freight: { mermaPct: 0 } }));
    expect(quote.items[0]!.pesoKg).toBe(1100);
  });

  it('ignora cualquier peso o nombre que intente colarse (el esquema ya los rechaza)', () => {
    const sucio = {
      ...request(),
      items: [{ stoneId: 'caliza', cantidad: 1, unidad: 'tonelada', pesoKg: 1, nombre: 'Falso' }],
    };
    expect(createQuoteRequestSchema.safeParse(sucio).success).toBe(false);
  });

  it('un acabado que la piedra no ofrece es un error de dominio', () => {
    const req = request({
      items: [{ stoneId: 'arenisca', acabado: 'Pulido espejo', cantidad: 1, unidad: 'tonelada' }],
    });
    expect(() => buildNewQuote(input({ request: req }))).toThrowError(NewQuoteError);
    try {
      buildNewQuote(input({ request: req }));
    } catch (e) {
      expect((e as NewQuoteError).code).toBe('invalid_finish');
      expect((e as Error).message).not.toContain('Pulido espejo');
    }
  });

  it('el acabado se compara exacto (mayúsculas distintas no valen)', () => {
    const req = request({
      items: [{ stoneId: 'arenisca', acabado: 'labrado', cantidad: 1, unidad: 'tonelada' }],
    });
    expect(() => buildNewQuote(input({ request: req }))).toThrow(NewQuoteError);
  });

  it.each([
    ['inexistente', [stones[1]!], 'unknown_stone'],
    ['inactiva', [arenisca!, stones[1]!, stones[2]!], 'inactive_stone'],
  ])('piedra %s: error de dominio con código estable', (_n, catalogo, code) => {
    const req = request({
      items:
        code === 'inactive_stone'
          ? [{ stoneId: 'travertino', cantidad: 1, unidad: 'tonelada' }]
          : [{ stoneId: 'arenisca', cantidad: 1, unidad: 'tonelada' }],
    });
    try {
      buildNewQuote(input({ request: req, stones: catalogo }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(NewQuoteError);
      expect((e as NewQuoteError).code).toBe(code);
      expect((e as Error).message).not.toMatch(/travertino|arenisca/i);
    }
  });

  it('unidad no vendida: error de dominio (unit_not_sold)', () => {
    const req = request({
      items: [{ stoneId: 'caliza', cantidad: 1, unidad: 'pieza' }],
    });
    expect(() => buildNewQuote(input({ request: req }))).toThrowError(
      expect.objectContaining({ code: 'unit_not_sold' }),
    );
  });

  it('espesor no disponible: error de dominio', () => {
    const req = request({
      items: [{ stoneId: 'arenisca', cantidad: 1, unidad: 'm2', espesorCm: 7 }],
    });
    expect(() => buildNewQuote(input({ request: req }))).toThrowError(
      expect.objectContaining({ code: 'thickness_not_available' }),
    );
  });

  it('un pedido demasiado grande es too_large (consúltenos por WhatsApp)', () => {
    const grande = makeStone({ id: 'gigante', nombre: 'Gigante' });
    const req = request({
      items: [{ stoneId: 'gigante', cantidad: 100_000, unidad: 'tonelada' }],
    });
    expect(() => buildNewQuote(input({ request: req, stones: [grande] }))).toThrowError(
      expect.objectContaining({ code: 'too_large' }),
    );
  });

  it('la suma de varias piedras también respeta el tope de peso total', () => {
    const a = makeStone({ id: 'a-uno', nombre: 'A' });
    const b = makeStone({ id: 'b-dos', nombre: 'B' });
    const req = request({
      items: [
        { stoneId: 'a-uno', cantidad: 300, unidad: 'tonelada' },
        { stoneId: 'b-dos', cantidad: 300, unidad: 'tonelada' },
      ],
    });
    expect(() => buildNewQuote(input({ request: req, stones: [a, b] }))).toThrowError(
      expect.objectContaining({ code: 'too_large' }),
    );
  });

  it('no modifica los argumentos', () => {
    const i = input();
    const antes = JSON.parse(JSON.stringify(i.request));
    buildNewQuote(i);
    expect(i.request).toEqual(antes);
  });
});

describe('buildNewQuote: source', () => {
  it('recorta userAgent a 200 y referrer a 300', () => {
    const { quote } = buildNewQuote(
      input({
        source: { userAgent: 'u'.repeat(500), referrer: `https://x.example/${'r'.repeat(500)}` },
      }),
    );
    expect(quote.source!.userAgent).toHaveLength(200);
    expect(quote.source!.referrer).toHaveLength(300);
  });

  it('quita query y fragmento del referrer y los caracteres de control', () => {
    const { quote } = buildNewQuote(
      input({
        source: {
          userAgent: 'Agente\u0000\nraro',
          referrer: 'https://sitio.example/contacto?correo=maria@example.com&tel=5550101#x',
        },
      }),
    );
    expect(quote.source!.referrer).toBe('https://sitio.example/contacto');
    expect(quote.source!.userAgent).toBe('Agente raro');
  });

  it('sin source útil, el documento no lo trae', () => {
    for (const source of [{}, { userAgent: '   ', referrer: '' }]) {
      const { quote } = buildNewQuote(input({ source }));
      expect('source' in quote).toBe(false);
    }
    const { quote } = buildNewQuote(input({ source: { userAgent: 'solo-ua' } }));
    expect(quote.source).toEqual({ userAgent: 'solo-ua' });
  });
});

describe('buildNewQuote: entradas inválidas del servidor', () => {
  it('un quoteId o folio mal formados no pasan el esquema final (falla en vez de guardar basura)', () => {
    expect(() => buildNewQuote(input({ quoteId: 'no-ulid' }))).toThrow();
    expect(() => buildNewQuote(input({ folio: 'CN-1-1' }))).toThrow();
  });
});

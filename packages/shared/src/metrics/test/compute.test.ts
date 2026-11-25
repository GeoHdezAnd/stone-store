import { describe, expect, it } from 'vitest';
import type { QuoteStatus } from '../../quote-status';
import type { HistoryEntry, Quote } from '../../quote/schema';
import { sampleQuote } from '../../quote/test/test-fixtures';
import {
  computeMetrics,
  NO_ZONE_LABEL,
  OTHER_ZONES_LABEL,
  ZONES_SHOWN,
  parseQuoteRows,
  RESPONSE_TARGET_HOURS,
  WAITING_ALERT_HOURS,
  zonePostalCodes,
} from '../compute';

// Martes 24 nov 2026 12:00 hora local (18:00Z). Semana actual desde el lunes 23 nov; mes desde el 1.
const NOW = Date.parse('2026-11-24T18:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms: number): string => new Date(ms).toISOString();

let seq = 0;
function q(over: Partial<Quote> = {}): Quote {
  seq += 1;
  const n = String(seq).padStart(5, '0');
  return sampleQuote({
    quoteId: `01ARZ3NDEKTSV4RRFFQ69${n}`,
    folio: `CN-2026-${n}`,
    createdAt: iso(NOW - HOUR),
    status: 'nueva',
    history: [],
    finalQuote: undefined,
    ...over,
  });
}
const ev = (at: string, a: QuoteStatus, de?: QuoteStatus): HistoryEntry => ({
  at,
  by: 'u1',
  tipo: 'estado',
  a,
  ...(de === undefined ? {} : { de }),
});
const fq = (total: number): NonNullable<Quote['finalQuote']> => ({
  items: [{ stoneId: 'arenisca', precioUnitario: total, subtotal: total }],
  fleteFinal: 0,
  subtotal: total,
  iva: null,
  ivaPct: null,
  total,
  vigenciaDias: 15,
});
const run = (quotes: Quote[], zoneByCp: Record<string, string> = {}) =>
  computeMetrics({ quotes, now: NOW, zoneByCp });

describe('computeMetrics: lista vacía', () => {
  const m = run([]);
  it('todo en cero y sin dividir entre cero', () => {
    expect(m.cards.pending).toEqual({ total: 0, nuevas: 0, enRevision: 0 });
    expect(m.cards.quoted).toEqual({ count: 0, value: 0, withoutAmount: 0 });
    expect(m.cards.won).toEqual({ count: 0, value: 0, withoutAmount: 0 });
    expect(m.cards.response).toEqual({
      averageHours: null,
      sampleSize: 0,
      pendingCount: 0,
      targetHours: RESPONSE_TARGET_HOURS,
      withinTarget: null,
    });
    expect(m.topStones).toEqual([]);
    expect(m.zones).toEqual([]);
    expect(m.waiting).toEqual({ items: [], total: 0, overdueCount: 0 });
    expect(m.funnel.map((f) => f.count)).toEqual([0, 0, 0, 0, 0, 0]);
  });
  it('siempre hay 8 semanas, de lunes, con etiqueta en español y la última es la actual', () => {
    expect(m.weekly).toHaveLength(8);
    expect(m.weekly.map((w) => w.start)).toEqual([
      '2026-10-05',
      '2026-10-12',
      '2026-10-19',
      '2026-10-26',
      '2026-11-02',
      '2026-11-09',
      '2026-11-16',
      '2026-11-23',
    ]);
    expect(m.weekly.map((w) => w.label)).toEqual([
      '5 oct',
      '12 oct',
      '19 oct',
      '26 oct',
      '2 nov',
      '9 nov',
      '16 nov',
      '23 nov',
    ]);
    expect(m.weekly.every((w) => w.count === 0)).toBe(true);
  });
});

describe('computeMetrics: por atender', () => {
  it('cuenta nuevas y en revisión (de cualquier antigüedad) y no otros estados', () => {
    const m = run([
      q({ status: 'nueva' }),
      q({ status: 'nueva', createdAt: '2026-01-05T10:00:00.000Z' }),
      q({ status: 'en_revision' }),
      q({ status: 'cotizada' }),
      q({ status: 'enviada' }),
      q({ status: 'ganada' }),
    ]);
    expect(m.cards.pending).toEqual({ total: 3, nuevas: 2, enRevision: 1 });
  });
});

describe('computeMetrics: solicitudes por semana (createdAt, huso local, lunes)', () => {
  const at = (s: string): Quote => q({ createdAt: s });
  it('el lunes 00:00 local (06:00Z) abre la semana; un ms antes es de la anterior', () => {
    const m = run([at('2026-11-23T06:00:00.000Z'), at('2026-11-23T05:59:59.999Z')]);
    expect(m.weekly[7]!.count).toBe(1);
    expect(m.weekly[6]!.count).toBe(1);
  });
  it('el inicio exacto de la primera semana entra y un ms antes queda fuera', () => {
    const m = run([at('2026-10-05T06:00:00.000Z'), at('2026-10-05T05:59:59.999Z')]);
    expect(m.weekly[0]!.count).toBe(1);
    expect(m.weekly.reduce((s, w) => s + w.count, 0)).toBe(1);
  });
  it('ignora solicitudes creadas después de `now`', () => {
    const m = run([at(iso(NOW + 1))]);
    expect(m.weekly[7]!.count).toBe(0);
    expect(m.cards.pending.total).toBe(0);
  });
});

describe('computeMetrics: cotizadas y ganadas del mes (por fecha del evento)', () => {
  it('cuenta por el evento, aunque la solicitud se creó antes del mes', () => {
    const m = run([
      q({
        createdAt: '2026-10-02T10:00:00.000Z',
        status: 'cotizada',
        finalQuote: fq(1000),
        history: [ev('2026-11-10T16:00:00.000Z', 'cotizada', 'en_revision')],
      }),
    ]);
    expect(m.cards.quoted).toEqual({ count: 1, value: 1000, withoutAmount: 0 });
  });
  it('frontera de mes en el huso local: 05:59:59.999Z del día 1 es octubre, 06:00Z es noviembre', () => {
    const base = { status: 'cotizada' as const, finalQuote: fq(100) };
    const m = run([
      q({ ...base, history: [ev('2026-11-01T05:59:59.999Z', 'cotizada')] }),
      q({ ...base, history: [ev('2026-11-01T06:00:00.000Z', 'cotizada')] }),
    ]);
    expect(m.cards.quoted.count).toBe(1);
  });
  it('una solicitud cotizada y luego enviada cuenta UNA vez (primer evento de cotización)', () => {
    const m = run([
      q({
        status: 'enviada',
        finalQuote: fq(500),
        history: [
          ev('2026-11-05T10:00:00.000Z', 'cotizada'),
          ev('2026-11-06T10:00:00.000Z', 'enviada', 'cotizada'),
        ],
      }),
    ]);
    expect(m.cards.quoted).toEqual({ count: 1, value: 500, withoutAmount: 0 });
  });
  it('[B] cotizada el 30-oct y enviada el 2-nov: noviembre cuenta 1 enviada y NO la cotización de octubre', () => {
    const m = run([
      q({
        createdAt: '2026-10-01T10:00:00.000Z',
        status: 'enviada',
        finalQuote: fq(500),
        history: [
          ev('2026-10-30T10:00:00.000Z', 'cotizada'),
          ev('2026-11-02T10:00:00.000Z', 'enviada', 'cotizada'),
        ],
      }),
    ]);
    expect(m.cards.quoted.count).toBe(0);
    expect(m.funnel.map((f) => f.count)).toEqual([0, 0, 0, 1, 0, 0]);
  });
  it('[C] cotizada en oct, en revisión el 3-nov y re-cotizada el 5-nov: noviembre cuenta 1 en revisión y 1 cotizada', () => {
    const m = run([
      q({
        createdAt: '2026-10-01T10:00:00.000Z',
        status: 'cotizada',
        finalQuote: fq(900),
        history: [
          ev('2026-10-20T10:00:00.000Z', 'cotizada', 'en_revision'),
          ev('2026-11-03T10:00:00.000Z', 'en_revision', 'cotizada'),
          ev('2026-11-05T10:00:00.000Z', 'cotizada', 'en_revision'),
        ],
      }),
    ]);
    expect(m.cards.quoted).toEqual({ count: 1, value: 900, withoutAmount: 0 });
    expect(m.funnel.map((f) => f.count)).toEqual([0, 1, 1, 0, 0, 0]);
  });
  it('varios eventos de la misma etapa en el mismo mes cuentan UNA vez (y el valor una vez)', () => {
    const m = run([
      q({
        status: 'cotizada',
        finalQuote: fq(300),
        history: [
          ev('2026-11-02T10:00:00.000Z', 'cotizada'),
          ev('2026-11-03T10:00:00.000Z', 'en_revision', 'cotizada'),
          ev('2026-11-04T10:00:00.000Z', 'cotizada', 'en_revision'),
          ev('2026-11-05T10:00:00.000Z', 'en_revision', 'cotizada'),
          ev('2026-11-06T10:00:00.000Z', 'cotizada', 'en_revision'),
        ],
      }),
    ]);
    expect(m.cards.quoted).toEqual({ count: 1, value: 300, withoutAmount: 0 });
    expect(m.funnel[1]!.count).toBe(1);
    expect(m.funnel[2]!.count).toBe(1);
  });
  it('el historial fuera de orden da lo mismo', () => {
    const history = [
      ev('2026-11-06T10:00:00.000Z', 'cotizada'),
      ev('2026-10-02T10:00:00.000Z', 'cotizada'),
      ev('2026-11-03T10:00:00.000Z', 'cotizada'),
    ];
    const mk = (h: typeof history) => q({ status: 'cotizada', finalQuote: fq(10), history: h });
    expect(run([mk(history)]).cards.quoted.count).toBe(1);
    expect(run([mk([...history].reverse())]).cards.quoted.count).toBe(1);
  });
  it('cada mes cuenta su propio evento: la misma solicitud cuenta en octubre y otra vez en noviembre', () => {
    const quote = q({
      createdAt: '2026-10-01T10:00:00.000Z',
      status: 'cotizada',
      finalQuote: fq(800),
      history: [
        ev('2026-10-20T10:00:00.000Z', 'cotizada', 'en_revision'),
        ev('2026-11-05T10:00:00.000Z', 'cotizada', 'en_revision'),
      ],
    });
    const inOct = computeMetrics({
      quotes: [quote],
      now: Date.parse('2026-10-28T18:00:00.000Z'),
      zoneByCp: {},
    });
    const inNov = run([quote]);
    expect(inOct.cards.quoted).toEqual({ count: 1, value: 800, withoutAmount: 0 });
    expect(inNov.cards.quoted).toEqual({ count: 1, value: 800, withoutAmount: 0 });
  });
  it('ganadas: cuenta y suma finalQuote.total en centavos (sin error de punto flotante)', () => {
    const won = (total: number) =>
      q({
        status: 'ganada',
        finalQuote: fq(total),
        history: [ev('2026-11-12T10:00:00.000Z', 'ganada', 'enviada')],
      });
    const m = run([won(0.1), won(0.2), won(1000.05)]);
    expect(m.cards.won).toEqual({ count: 3, value: 1000.35, withoutAmount: 0 });
  });
  it('suma en centavos enteros importes que en flotante x100 no son exactos', () => {
    const won = (total: number) =>
      q({
        status: 'ganada',
        finalQuote: fq(total),
        history: [ev('2026-11-12T10:00:00.000Z', 'ganada', 'enviada')],
      });
    expect(run([won(0.29)]).cards.won.value).toBe(0.29);
    expect(run([won(1.15), won(0.57)]).cards.won.value).toBe(1.72);
  });
  it('el evento de envío NO cuenta como cotizada (esa etapa es solo «cotizada»); cuenta como enviada', () => {
    const m = run([
      q({
        status: 'enviada',
        finalQuote: fq(70),
        history: [ev('2026-11-06T10:00:00.000Z', 'enviada', 'cotizada')],
      }),
    ]);
    expect(m.cards.quoted).toEqual({ count: 0, value: 0, withoutAmount: 0 });
    expect(m.funnel[3]!.count).toBe(1);
  });
  it('sin finalQuote no inventa importe: cuenta la solicitud y la marca sin importe', () => {
    const m = run([
      q({
        status: 'ganada',
        history: [ev('2026-11-12T10:00:00.000Z', 'ganada', 'enviada')],
      }),
    ]);
    expect(m.cards.won).toEqual({ count: 1, value: 0, withoutAmount: 1 });
  });
  it('un evento en el futuro respecto a `now` no cuenta', () => {
    const m = run([q({ status: 'ganada', history: [ev(iso(NOW + HOUR), 'ganada', 'enviada')] })]);
    expect(m.cards.won.count).toBe(0);
  });
});

describe('computeMetrics: tiempo de respuesta', () => {
  const answered = (createdAt: string, respondedAt: string) =>
    q({ status: 'enviada', createdAt, respondedAt });
  it('promedia respondedAt - createdAt en horas corridas (respuestas del mes)', () => {
    const m = run([
      answered('2026-11-10T10:00:00.000Z', '2026-11-10T20:00:00.000Z'), // 10 h
      answered('2026-11-11T10:00:00.000Z', '2026-11-12T22:00:00.000Z'), // 36 h
    ]);
    expect(m.cards.response.averageHours).toBe(23);
    expect(m.cards.response.sampleSize).toBe(2);
    expect(m.cards.response.withinTarget).toBe(true);
  });
  it('la meta se evalúa con el promedio SIN redondear (47.96 h se muestra 48 pero cumple)', () => {
    // 47 h 57 min 36 s = 47.96 h exactas.
    const created = Date.parse('2026-11-10T10:00:00.000Z');
    const m = run([answered(iso(created), iso(created + 47 * HOUR + 57 * 60_000 + 36_000))]);
    expect(m.cards.response.averageHours).toBe(48);
    expect(m.cards.response.withinTarget).toBe(true);
  });
  it('48 h exactas de promedio ya no cumplen la meta (< 48 h)', () => {
    const m = run([answered('2026-11-10T10:00:00.000Z', '2026-11-12T10:00:00.000Z')]);
    expect(m.cards.response.averageHours).toBe(48);
    expect(m.cards.response.withinTarget).toBe(false);
  });
  it('redondea a 1 decimal', () => {
    const m = run([answered('2026-11-10T10:00:00.000Z', '2026-11-10T10:20:00.000Z')]);
    expect(m.cards.response.averageHours).toBe(0.3);
  });
  it('excluye respuestas de otros meses y las negativas (dato corrupto)', () => {
    const m = run([
      answered('2026-10-10T10:00:00.000Z', '2026-10-10T12:00:00.000Z'),
      answered('2026-11-10T10:00:00.000Z', '2026-11-10T09:00:00.000Z'),
    ]);
    expect(m.cards.response.sampleSize).toBe(0);
    expect(m.cards.response.averageHours).toBeNull();
    expect(m.cards.response.withinTarget).toBeNull();
  });
  it('las del mes sin respondedAt se cuentan aparte como pendientes (no canceladas)', () => {
    const m = run([
      q({ status: 'nueva', createdAt: '2026-11-10T10:00:00.000Z' }),
      q({ status: 'cancelada', createdAt: '2026-11-10T10:00:00.000Z' }),
      q({ status: 'nueva', createdAt: '2026-10-10T10:00:00.000Z' }),
    ]);
    expect(m.cards.response.pendingCount).toBe(1);
    expect(m.cards.response.averageHours).toBeNull();
  });
  it('pendientes concuerdan con «esperando respuesta»: incluyen cotizadas sin enviar y no las ganadas', () => {
    const m = run([
      q({ status: 'cotizada', createdAt: '2026-11-10T10:00:00.000Z' }),
      q({ status: 'en_revision', createdAt: '2026-11-10T10:00:00.000Z' }),
      q({ status: 'ganada', createdAt: '2026-11-10T10:00:00.000Z' }),
    ]);
    expect(m.cards.response.pendingCount).toBe(2);
  });
});

describe('computeMetrics: piedras más solicitadas (30 días)', () => {
  const item = (stoneId: string, nombre: string): Quote['items'][number] => ({
    stoneId,
    nombre,
    acabado: '',
    cantidad: 1,
    unidad: 'm2',
    pesoKg: 10,
  });
  it('cuenta solicitudes por piedra, ordena por cantidad y luego por nombre, máximo 5', () => {
    const quotes = [
      q({ items: [item('a', 'Arenisca'), item('c', 'Caliza')] }),
      q({ items: [item('a', 'Arenisca')] }),
      q({ items: [item('b', 'Basalto'), item('c', 'Caliza')] }),
      q({ items: [item('d', 'Dolomita')] }),
      q({ items: [item('e', 'Esquisto')] }),
      q({ items: [item('f', 'Fonolita')] }),
    ];
    const m = run(quotes);
    expect(m.topStones).toHaveLength(5);
    expect(m.topStones.slice(0, 3)).toEqual([
      { stoneId: 'a', nombre: 'Arenisca', count: 2 },
      { stoneId: 'c', nombre: 'Caliza', count: 2 },
      { stoneId: 'b', nombre: 'Basalto', count: 1 },
    ]);
  });
  it('la ventana es de 30 días exactos hacia atrás', () => {
    const m = run([
      q({ createdAt: iso(NOW - 30 * DAY), items: [item('a', 'Arenisca')] }),
      q({ createdAt: iso(NOW - 30 * DAY - 1), items: [item('z', 'Zeolita')] }),
    ]);
    expect(m.topStones).toEqual([{ stoneId: 'a', nombre: 'Arenisca', count: 1 }]);
  });
});

describe('computeMetrics: zonas', () => {
  it('agrupa por estado vía el diccionario de CP; CP ausente = «Sin dato» al final', () => {
    const cp = (codigoPostal: string) => ({
      lugar: 'Obra',
      codigoPostal,
      uso: '',
      notas: '',
    });
    const m = run(
      [
        q({ works: cp('72810') }),
        q({ works: cp('72810') }),
        q({ works: cp('90000') }),
        q({ works: cp('99999') }),
        q({ works: cp('99998') }),
        q({ works: cp('99997') }),
        q({ works: cp('90000'), createdAt: iso(NOW - 31 * DAY) }),
      ],
      { '72810': 'Puebla', '90000': 'Tlaxcala' },
    );
    expect(m.zones).toEqual([
      { estado: 'Puebla', count: 2 },
      { estado: 'Tlaxcala', count: 1 },
      { estado: NO_ZONE_LABEL, count: 3 },
    ]);
  });
});

describe('computeMetrics: zonas con datos sucios (nunca tiran el resumen)', () => {
  const cp = (n: number) => ({
    lugar: 'Obra',
    codigoPostal: String(n).padStart(5, '0'),
    uso: '',
    notas: '',
  });
  it('agrupa «Puebla», «  puebla » y «PUEBLA» y muestra la forma más frecuente', () => {
    const zoneByCp = {
      '00001': 'Puebla',
      '00002': '  puebla ',
      '00003': 'Puebla',
      '00004': 'PUEBLA',
    };
    const m = run(
      [1, 2, 3, 4].map((n) => q({ works: cp(n) })),
      zoneByCp,
    );
    expect(m.zones).toEqual([{ estado: 'Puebla', count: 4 }]);
  });
  it('ignora acentos y espacios repetidos al agrupar', () => {
    const zoneByCp = {
      '00001': 'Querétaro',
      '00002': 'Queretaro',
      '00003': 'Querétaro de   Arteaga',
      '00004': 'Querétaro',
    };
    const m = run(
      [1, 2, 3, 4].map((n) => q({ works: cp(n) })),
      zoneByCp,
    );
    expect(m.zones).toEqual([
      { estado: 'Querétaro', count: 3 },
      { estado: 'Querétaro de Arteaga', count: 1 },
    ]);
  });
  it('con 150 estados distintos muestra los primeros N, agrupa el resto en «Otros» y cabe en el esquema', () => {
    const zoneByCp: Record<string, string> = {};
    const quotes: Quote[] = [];
    for (let i = 1; i <= 150; i++) {
      zoneByCp[String(i).padStart(5, '0')] = `Estado ${String(i).padStart(3, '0')}`;
      quotes.push(q({ works: cp(i) }));
    }
    quotes.push(q({ works: cp(1) })); // «Estado 001» pasa a tener 2
    quotes.push(q({ works: cp(99999) })); // sin dato
    const m = run(quotes, zoneByCp);
    expect(m.zones).toHaveLength(ZONES_SHOWN + 2);
    expect(m.zones[0]).toEqual({ estado: 'Estado 001', count: 2 });
    expect(m.zones.at(-2)).toEqual({ estado: OTHER_ZONES_LABEL, count: 150 - ZONES_SHOWN });
    expect(m.zones.at(-1)).toEqual({ estado: NO_ZONE_LABEL, count: 1 });
    expect(m.zones.reduce((s, z) => s + z.count, 0)).toBe(152);
    expect(ZONES_SHOWN + 2).toBeLessThanOrEqual(100);
  });
  it('si caben todas no crea «Otros»', () => {
    const zoneByCp = { '00001': 'Puebla' };
    const m = run([q({ works: cp(1) })], zoneByCp);
    expect(m.zones.map((z) => z.estado)).toEqual(['Puebla']);
  });
});

describe('computeMetrics: embudo del mes', () => {
  it('cuenta solicitudes distintas por etapa según el evento dentro del mes', () => {
    const inMonth = (d: number) => `2026-11-${String(d).padStart(2, '0')}T15:00:00.000Z`;
    const m = run([
      q({ createdAt: inMonth(2) }), // nueva del mes
      q({
        createdAt: '2026-10-20T10:00:00.000Z',
        status: 'perdida',
        history: [
          ev(inMonth(3), 'en_revision', 'nueva'),
          ev(inMonth(4), 'cotizada', 'en_revision'),
          ev(inMonth(5), 'enviada', 'cotizada'),
          ev(inMonth(9), 'perdida', 'enviada'),
        ],
      }),
      q({
        createdAt: inMonth(1),
        status: 'ganada',
        history: [
          ev(inMonth(2), 'en_revision', 'nueva'),
          ev(inMonth(2), 'cotizada', 'en_revision'),
          ev(inMonth(3), 'cotizada', 'en_revision'),
          ev(inMonth(4), 'enviada', 'cotizada'),
          ev(inMonth(8), 'ganada', 'enviada'),
        ],
      }),
    ]);
    expect(m.funnel).toEqual([
      { stage: 'nuevas', label: 'Nuevas', count: 2 },
      { stage: 'en_revision', label: 'En revisión', count: 2 },
      { stage: 'cotizadas', label: 'Cotizadas', count: 2 },
      { stage: 'enviadas', label: 'Enviadas', count: 2 },
      { stage: 'ganadas', label: 'Ganadas', count: 1 },
      { stage: 'perdidas', label: 'Perdidas', count: 1 },
    ]);
  });
});

describe('computeMetrics: esperando respuesta', () => {
  it('nueva, en revisión y cotizada sin enviar; la más antigua primero, con estado, folio, cliente, obra y antigüedad', () => {
    const m = run([
      q({ folio: 'CN-2026-00002', createdAt: iso(NOW - 5 * HOUR), status: 'nueva' }),
      q({ folio: 'CN-2026-00001', createdAt: iso(NOW - 50 * HOUR), status: 'en_revision' }),
      q({ folio: 'CN-2026-00003', status: 'cotizada', createdAt: iso(NOW - 90 * HOUR) }),
      q({ status: 'enviada', createdAt: iso(NOW - 200 * HOUR) }),
      q({ status: 'ganada', createdAt: iso(NOW - 200 * HOUR) }),
    ]);
    expect(m.waiting.total).toBe(3);
    expect(m.waiting.items.map((i) => i.folio)).toEqual([
      'CN-2026-00003',
      'CN-2026-00001',
      'CN-2026-00002',
    ]);
    expect(m.waiting.items[1]).toEqual({
      quoteId: expect.any(String),
      folio: 'CN-2026-00001',
      status: 'en_revision',
      cliente: 'Cliente Ejemplo',
      lugar: 'San Andrés Cholula',
      createdAt: iso(NOW - 50 * HOUR),
      ageHours: 50,
      overdue: true,
    });
    expect(m.waiting.items.map((i) => i.status)).toEqual(['cotizada', 'en_revision', 'nueva']);
    expect(m.waiting.items[2]!.overdue).toBe(false);
    expect(m.waiting.overdueCount).toBe(2);
    // «Por atender» sigue siendo solo nueva + en revisión.
    expect(m.cards.pending).toEqual({ total: 2, nuevas: 1, enRevision: 1 });
  });
  it('[A] una cotizada de hace 5 días sin enviar aparece en esperando y en la alerta de 48 h', () => {
    const m = run([q({ status: 'cotizada', createdAt: iso(NOW - 5 * DAY) })]);
    expect(m.waiting.total).toBe(1);
    expect(m.waiting.items[0]).toMatchObject({ status: 'cotizada', ageHours: 120, overdue: true });
    expect(m.waiting.overdueCount).toBe(1);
  });
  it('alerta solo si la antigüedad supera 48 h (48 h exactas no)', () => {
    expect(WAITING_ALERT_HOURS).toBe(48);
    const m = run([
      q({ createdAt: iso(NOW - 48 * HOUR) }),
      q({ createdAt: iso(NOW - 48 * HOUR - 1) }),
    ]);
    expect(m.waiting.overdueCount).toBe(1);
  });
  it('el aviso por solicitud tampoco salta con 48 h exactas', () => {
    const m = run([
      q({ folio: 'CN-2026-00001', createdAt: iso(NOW - 48 * HOUR) }),
      q({ folio: 'CN-2026-00002', createdAt: iso(NOW - 48 * HOUR - 1) }),
    ]);
    expect(m.waiting.items.map((i) => i.overdue)).toEqual([true, false]);
  });
  it('muestra a lo más 10, pero total y vencidas cuentan todas', () => {
    const rows = Array.from({ length: 12 }, (_, i) => q({ createdAt: iso(NOW - (60 + i) * HOUR) }));
    const m = run(rows);
    expect(m.waiting.items).toHaveLength(10);
    expect(m.waiting.total).toBe(12);
    expect(m.waiting.overdueCount).toBe(12);
  });
});

describe('computeMetrics: robustez', () => {
  it('descarta duplicados por quoteId (se queda con la primera)', () => {
    const a = q({ status: 'nueva' });
    const m = run([a, { ...a }]);
    expect(m.cards.pending.total).toBe(1);
  });
  it('acepta `now` como Date', () => {
    const m = computeMetrics({ quotes: [], now: new Date(NOW), zoneByCp: {} });
    expect(m.weekly[7]!.start).toBe('2026-11-23');
  });
});

describe('zonePostalCodes', () => {
  const cp = (codigoPostal: string, createdAt = iso(NOW - HOUR)) =>
    q({ createdAt, works: { lugar: 'x', codigoPostal, uso: '', notas: '' } });
  it('devuelve los CP distintos de los últimos 30 días, sin repetir', () => {
    const r = zonePostalCodes(
      [cp('72810'), cp('72810'), cp('90000'), cp('11111', iso(NOW - 31 * DAY))],
      NOW,
      10,
    );
    expect(r).toEqual({ codes: ['72810', '90000'], capped: false });
  });
  it('respeta el tope y avisa que se recortó', () => {
    const r = zonePostalCodes([cp('00001'), cp('00002'), cp('00003')], NOW, 2);
    expect(r.codes).toHaveLength(2);
    expect(r.capped).toBe(true);
  });
  it('lista vacía', () => {
    expect(zonePostalCodes([], NOW, 5)).toEqual({ codes: [], capped: false });
  });
});

describe('parseQuoteRows', () => {
  it('valida con quoteSchema, quita claves de índice y omite filas inválidas sin lanzar', () => {
    const ok = {
      ...q(),
      gsi1pk: 'STATUS#nueva',
      gsi1sk: 'x',
      gsi2pk: 'QUOTE',
      gsi2sk: 'y',
      searchKey: 'z',
    };
    const bad = { quoteId: 'X', folio: 'mal' };
    const r = parseQuoteRows([ok, bad, null, 42, { quoteId: 'solo-id' }]);
    expect(r.quotes).toHaveLength(1);
    expect(r.quotes[0]!.quoteId).toBe(ok.quoteId);
    expect(r.invalidIds).toEqual(['X', null, null, 'solo-id']);
  });
});

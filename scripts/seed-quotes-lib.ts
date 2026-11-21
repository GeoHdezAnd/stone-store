/**
 * Lógica pura del seed de solicitudes de EJEMPLO (sin AWS): arma ~30 solicitudes `ejemplo: true`
 * con clientes ficticios (@example.com, teléfonos 555-0100…), repartidas por estado y fecha, con
 * folios consecutivos por año, estimado de flete calculado con `estimateFreight` sobre
 * `content/freight-config.json` y piedras de `content/`. Determinista: misma entrada, mismas filas.
 * La escritura a DynamoDB (contador de folios incluido) vive en `seed-quotes.ts`.
 */
import {
  computeFinalQuote,
  computeWeightKg,
  estimateFreight,
  folioCounterName,
  formatFolio,
  FreightError,
  freightConfigSchema,
  generateUlid,
  LOST_REASONS,
  quoteIndexKeys,
  quoteSchema,
  type FreightConfig,
  type HistoryEntry,
  type Quote,
  type QuoteStatus,
  type Stone,
} from '../packages/shared/src/index';
import { buildSeedPlan, readContent } from './seed-lib';
import { buildFreightSeed, readFreightContent } from './seed-freight-lib';

import { checkSeedEnv } from './seed-freight-lib';

export { checkSeedEnv };

/**
 * Salvaguardas del seed de solicitudes. En prod consume los contadores de folio REALES (`Counters`):
 * además de `SEED_CONFIRM_PROD=si` exige `SEED_ALLOW_PROD_COUNTERS=si`. Los folios de ejemplo
 * quemarían números de folio del negocio real, por eso en prod no basta una sola confirmación.
 */
export function checkQuotesSeedEnv(env: Record<string, string | undefined>): 'dev' | 'prod' {
  const appEnv = checkSeedEnv(env);
  if (appEnv === 'prod' && env['SEED_ALLOW_PROD_COUNTERS'] !== 'si') {
    throw new Error(
      'En prod el seed de solicitudes consume los folios reales de Counters: define también SEED_ALLOW_PROD_COUNTERS=si. Abortado.',
    );
  }
  return appEnv;
}

export const SEED_QUOTE_COUNT = 30;
const SEED_USER = 'seed';
const DAY = 86_400_000;
const HOUR = 3_600_000;

// El nombre del contador vive en `packages/shared` (lo comparten este seed y `quotes-create`).
export { folioCounterName };

// De la más antigua (0) a la más reciente (29): lo viejo está más avanzado en el embudo.
const STATUS_PLAN: readonly QuoteStatus[] = [
  'ganada',
  'ganada',
  'perdida',
  'ganada',
  'perdida',
  'cancelada',
  'enviada',
  'enviada',
  'enviada',
  'enviada',
  'enviada',
  'cotizada',
  'cotizada',
  'cotizada',
  'cotizada',
  'cotizada',
  'en_revision',
  'en_revision',
  'en_revision',
  'en_revision',
  'en_revision',
  'cancelada',
  'nueva',
  'nueva',
  'nueva',
  'nueva',
  'nueva',
  'nueva',
  'nueva',
  'nueva',
];

const FIRST = [
  'Ana',
  'Luis',
  'Marta',
  'Pedro',
  'Sofía',
  'Jorge',
  'Lucía',
  'Raúl',
  'Elena',
  'Diego',
];
const LAST = [
  'Ramírez',
  'Hernández',
  'Flores',
  'Morales',
  'Ortega',
  'Vega',
  'Castillo',
  'Rivera',
  'Mendoza',
  'Salas',
];
const PLACES = [
  'San Andrés Cholula',
  'Puebla centro',
  'Tlaxcala',
  'Atlixco',
  'Xalapa',
  'Coatepec',
  'CDMX Coyoacán',
  'Huamantla',
];
const USES = ['Fachada', 'Piso de patio', 'Cubierta de cocina', 'Jardín', 'Muro de sillería'];

export interface SeedInputs {
  stones: readonly Stone[];
  config: FreightConfig;
}

/** Lee y valida las piedras de `content/` y la tarifa de ejemplo. Lanza si algo no es válido. */
export function loadSeedInputs(contentDir: string, nowIso: string): SeedInputs {
  const stonesTable = buildSeedPlan(readContent(contentDir)).find((t) => t.table === 'Stones');
  const stones = (stonesTable?.items ?? []) as Stone[];
  const { row } = buildFreightSeed(readFreightContent(contentDir), nowIso);
  return { stones, config: freightConfigSchema.parse(row) };
}

/** Instante de creación de la solicitud i (0 = la más antigua): hasta ~39 días antes de `now`. */
function createdMs(now: Date, i: number): number {
  return now.getTime() - 3 * HOUR - (SEED_QUOTE_COUNT - 1 - i) * 1.3 * DAY - i * 37 * 60_000;
}

/** Cuántas solicitudes caen en cada año (para reservar los folios de cada contador). */
export function seedYearCounts(now: Date, from = 0): Record<string, number> {
  if (!Number.isInteger(from) || from < 0 || from > SEED_QUOTE_COUNT) {
    throw new RangeError('from debe estar entre 0 y 30.');
  }
  const counts: Record<string, number> = {};
  for (let i = from; i < SEED_QUOTE_COUNT; i++) {
    const year = new Date(createdMs(now, i)).getUTCFullYear();
    counts[String(year)] = (counts[String(year)] ?? 0) + 1;
  }
  return counts;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class QuoteSeedValidationError extends Error {
  public constructor(public readonly errors: readonly string[]) {
    super(`Las solicitudes de ejemplo no son válidas:\n- ${errors.join('\n- ')}`);
    this.name = 'QuoteSeedValidationError';
  }
}

/**
 * Arma las filas (dominio + claves de índice + searchKey). `folioStart[año]` es el primer número
 * de folio reservado en el contador de ese año; dentro de cada año se asignan en orden cronológico.
 */
export function buildQuoteSeeds(input: {
  now: Date;
  stones: readonly Stone[];
  config: FreightConfig;
  folioStart: Record<string, number>;
  /** Índice (0-29) desde el que generar: completa un seed parcial (por defecto 0 = todas). */
  from?: number;
}): Record<string, unknown>[] {
  const { now, stones, config, folioStart } = input;
  const from = input.from ?? 0;
  if (!Number.isInteger(from) || from < 0 || from > SEED_QUOTE_COUNT) {
    throw new RangeError('from debe estar entre 0 y 30.');
  }
  const candidates = stones.filter(
    (s) => s.activa && s.vendidaPor.includes('m2') && s.espesoresCm.length > 0,
  );
  if (candidates.length < 3)
    throw new QuoteSeedValidationError(['Se necesitan al menos 3 piedras vendibles por m²']);
  const zonas = config.zonasCubiertas.filter((z) => z.length >= 2);
  const nextInYear: Record<string, number> = { ...folioStart };

  const errors: string[] = [];
  const rows: Record<string, unknown>[] = [];

  for (let i = from; i < SEED_QUOTE_COUNT; i++) {
    const status = STATUS_PLAN[i] as QuoteStatus;
    const created = createdMs(now, i);
    const createdAt = new Date(created).toISOString();
    const year = String(new Date(created).getUTCFullYear());
    const start = nextInYear[year];
    if (start === undefined)
      throw new QuoteSeedValidationError([`Falta el folio inicial del año ${year}`]);
    nextInYear[year] = start + 1;
    const rnd = mulberry32(i + 1);

    // Renglones: 1 a 3 piedras distintas, siempre en m².
    const requests = Array.from({ length: 1 + (i % 3) }, (_, k) => {
      const stone = candidates[(i * 3 + k) % candidates.length] as Stone;
      return {
        stone,
        item: {
          stoneId: stone.id,
          cantidad: 5 + ((i * 7 + k * 11) % 60),
          unidad: 'm2' as const,
          espesorCm: stone.espesoresCm[0] as number,
        },
      };
    });
    const freightItems = requests.map((r) => r.item);
    const items = requests.map((r) => ({
      stoneId: r.stone.id,
      nombre: r.stone.nombre,
      acabado: r.stone.acabados[0] ?? '',
      cantidad: r.item.cantidad,
      unidad: r.item.unidad,
      pesoKg: computeWeightKg([r.item], [r.stone], config),
    }));

    const prefix = zonas[i % zonas.length] as string;
    const codigoPostal = `${prefix}${String(100 + ((i * 37) % 800)).padStart(3, '0')}`
      .slice(0, 5)
      .padEnd(5, '0');
    const distanciaKm = 20 + ((i * 37) % 300);

    let freight: Quote['freight'];
    try {
      const e = estimateFreight({ codigoPostal, distanciaKm, items: freightItems, stones, config });
      freight = {
        estimadoMin: e.estimadoMin,
        estimadoMax: e.estimadoMax,
        moneda: 'MXN',
        pesoTotalKg: e.pesoTotalKg,
        distanciaKm: e.distanciaKm,
        camion: e.camion,
        viajes: e.viajes,
        versionTarifa: e.versionTarifa,
        calculadoAt: createdAt,
      };
    } catch (err) {
      if (!(err instanceof FreightError)) throw err;
    }

    // Historial coherente con el estado final (cada paso +1 h; las más recientes no tienen pasos).
    const history: HistoryEntry[] = [];
    let step = 0;
    const at = (): string => new Date(created + ++step * HOUR).toISOString();
    const estado = (de: QuoteStatus, a: QuoteStatus, texto?: string): void => {
      history.push({ at: at(), by: SEED_USER, tipo: 'estado', de, a, ...(texto ? { texto } : {}) });
    };
    const reviewed = status !== 'nueva';
    const quoted = ['cotizada', 'enviada', 'ganada', 'perdida'].includes(status);
    const sent = ['enviada', 'ganada', 'perdida'].includes(status);
    if (reviewed) estado('nueva', 'en_revision');
    let finalQuote: Quote['finalQuote'];
    if (quoted) {
      history.push({
        at: at(),
        by: SEED_USER,
        tipo: 'edicion',
        texto: 'Precios y flete actualizados',
      });
      const computed = computeFinalQuote({
        items,
        prices: items.map((it, k) => ({
          stoneId: it.stoneId,
          precioUnitario: 150 + ((i + k * 7) % 20) * 10,
        })),
        fleteFinal: freight?.estimadoMax ?? 1500,
        vigenciaDias: 15,
      });
      finalQuote = computed;
      estado('en_revision', 'cotizada');
    }
    let respondedAt: string | undefined;
    if (sent) {
      respondedAt = at();
      history.push({
        at: respondedAt,
        by: SEED_USER,
        tipo: 'correo',
        texto: 'Cotización enviada al cliente',
      });
      estado('cotizada', 'enviada');
      finalQuote = { ...(finalQuote as NonNullable<typeof finalQuote>), enviadaAt: respondedAt };
    }
    let lostReason: Quote['lostReason'];
    if (status === 'ganada') estado('enviada', 'ganada');
    if (status === 'perdida') {
      lostReason = LOST_REASONS[i % LOST_REASONS.length];
      estado('enviada', 'perdida', `Motivo: ${lostReason}`);
    }
    if (status === 'cancelada') estado('en_revision', 'cancelada');

    const notes: Quote['notes'] = [];
    if (i % 5 === 0) {
      const when = at();
      notes.push({ at: when, by: SEED_USER, texto: 'Nota interna de ejemplo.' });
      history.push({ at: when, by: SEED_USER, tipo: 'nota', texto: 'Nota interna agregada' });
    }

    const quote: Quote = {
      quoteId: generateUlid(created, rnd),
      folio: formatFolio(Number(year), start),
      createdAt,
      status,
      customer: {
        nombre: `${FIRST[i % FIRST.length]} ${LAST[(i * 3) % LAST.length]}`,
        telefono: `555-01${String(i).padStart(2, '0')}`,
        correo: `cliente${String(i + 1).padStart(2, '0')}@example.com`,
      },
      works: {
        lugar: PLACES[i % PLACES.length] as string,
        codigoPostal,
        uso: USES[i % USES.length] as string,
        notas: '',
      },
      items,
      ...(freight ? { freight } : {}),
      ...(finalQuote ? { finalQuote } : {}),
      history,
      notes,
      ...(lostReason ? { lostReason } : {}),
      ...(respondedAt ? { respondedAt } : {}),
      consentAt: createdAt,
      source: { userAgent: 'seed' },
      rev: history.length + 1,
      ejemplo: true,
    };
    const parsed = quoteSchema.safeParse(quote);
    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        errors.push(`#${i} ${issue.path.join('.')}: ${issue.message}`);
      continue;
    }
    rows.push({ ...parsed.data, ...quoteIndexKeys(parsed.data) });
  }
  if (errors.length > 0) throw new QuoteSeedValidationError(errors);
  return rows;
}

import { toCents } from '../freight/config';
import { quoteSchema, stripStorageKeys, type Quote } from '../quote/schema';
import { mxnFromCents } from '../quote/totals';
import {
  addLocalDays,
  DAY_MS,
  localDateString,
  localShortLabel,
  localStartOfMonth,
  localStartOfWeek,
} from './time';

// Cálculo PURO de las métricas del Resumen (CLAUDE.md 5.3 y 5.5). Sin AWS ni I/O: recibe las
// solicitudes ya validadas y el instante de referencia, y devuelve los números del dashboard.
//
// Reglas (decisiones del dueño):
// - Etapas del mes (embudo, «cotizadas» y «ganadas»): se cuentan por la FECHA DEL EVENTO (entrada de
//   `history[]` con `a` = esa etapa), no por `createdAt`. Una solicitud cuenta en una etapa de un mes
//   si CUALQUIER evento de esa etapa cae en ese mes, y UNA sola vez por mes (aunque tenga varios);
//   en otro mes vuelve a contar con su propio evento. El orden del historial no importa. El valor es
//   el `finalQuote.total` vigente de la fila (se suma una vez por mes). «Cotizadas» es solo la
//   etapa `cotizada` (el envío cuenta aparte en «Enviadas»).
//   Nuevas, solicitudes por semana, piedras y zonas usan `createdAt`.
// - «Esperando respuesta» = nueva, en revisión y COTIZADA sin enviar (mientras no se envíe, el
//   cliente sigue esperando); su antigüedad y la alerta de 48 h se miden desde `createdAt`. Las
//   «pendientes» del tiempo de respuesta y `overdueCount` salen de ese mismo conjunto. «Por atender»
//   sigue siendo solo nueva + en revisión.
// - Huso `America/Mexico_City` (ver time.ts); semana desde el lunes; mes calendario local.
// - Importes en MXN tomados de `finalQuote.total`: piedra + IVA (solo sobre la piedra, si lo hay) +
//   flete, es decir el importe CON IVA y flete. Si la solicitud no tiene `finalQuote` NO se inventa un importe: cuenta en el
//   conteo pero se anota en `withoutAmount` (no se usa `freight.estimadoMax`, que es solo flete).
// - Las filas con `ejemplo: true` SÍ cuentan.

export const RESPONSE_TARGET_HOURS = 48;
export const WAITING_ALERT_HOURS = 48;
export const WEEKS_SHOWN = 8;
export const TOP_STONES_LIMIT = 5;
export const WINDOW_DAYS = 30;
export const WAITING_LIMIT = 10;
export const NO_ZONE_LABEL = 'Sin dato';
export const OTHER_ZONES_LABEL = 'Otros';
/** Zonas mostradas antes de agrupar el resto en «Otros» (el esquema admite hasta 100 filas). */
export const ZONES_SHOWN = 15;

const HOUR_MS = 3_600_000;

export const FUNNEL_STAGES = [
  { stage: 'nuevas', label: 'Nuevas' },
  { stage: 'en_revision', label: 'En revisión' },
  { stage: 'cotizadas', label: 'Cotizadas' },
  { stage: 'enviadas', label: 'Enviadas' },
  { stage: 'ganadas', label: 'Ganadas' },
  { stage: 'perdidas', label: 'Perdidas' },
] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number]['stage'];

export interface AmountCard {
  count: number;
  /** MXN. */
  value: number;
  /** Solicitudes contadas que no tienen `finalQuote` (no suman al valor). */
  withoutAmount: number;
}

export interface ComputedMetrics {
  cards: {
    pending: { total: number; nuevas: number; enRevision: number };
    quoted: AmountCard;
    won: AmountCard;
    response: {
      averageHours: number | null;
      sampleSize: number;
      pendingCount: number;
      targetHours: number;
      withinTarget: boolean | null;
    };
  };
  weekly: { start: string; label: string; count: number }[];
  topStones: { stoneId: string; nombre: string; count: number }[];
  funnel: { stage: FunnelStage; label: string; count: number }[];
  zones: { estado: string; count: number }[];
  waiting: {
    items: {
      quoteId: string;
      folio: string;
      cliente: string;
      lugar: string;
      status: 'nueva' | 'en_revision' | 'cotizada';
      createdAt: string;
      ageHours: number;
      overdue: boolean;
    }[];
    total: number;
    overdueCount: number;
  };
}

export interface MetricsInput {
  quotes: readonly Quote[];
  now: number | Date;
  /** Código postal -> estado (de `PostalCodes`). Los CP ausentes caen en «Sin dato». */
  zoneByCp: Readonly<Record<string, string>>;
}

const toMs = (now: number | Date): number => (now instanceof Date ? now.getTime() : now);

/** Solicitudes únicas por `quoteId` (la primera gana) y creadas hasta `now`. */
function eligible(quotes: readonly Quote[], nowMs: number): Quote[] {
  const seen = new Set<string>();
  const out: Quote[] = [];
  for (const q of quotes) {
    if (seen.has(q.quoteId)) continue;
    seen.add(q.quoteId);
    if (Date.parse(q.createdAt) <= nowMs) out.push(q);
  }
  return out;
}

/** ¿Hay algún evento del historial con estado destino `stage` dentro de [monthStart, nowMs]? */
function hasEventInMonth(q: Quote, stage: string, monthStart: number, nowMs: number): boolean {
  return q.history.some((h) => {
    if (h.a !== stage) return false;
    const t = Date.parse(h.at);
    return t >= monthStart && t <= nowMs;
  });
}

/** Estados en que el cliente sigue esperando una respuesta (cotizada = aún sin enviar). */
const WAITING_STATUSES: readonly string[] = ['nueva', 'en_revision', 'cotizada'];

function amountCard(rows: readonly Quote[]): AmountCard {
  let cents = 0;
  let withoutAmount = 0;
  for (const q of rows) {
    if (q.finalQuote === undefined) withoutAmount += 1;
    else cents += toCents(q.finalQuote.total);
  }
  return { count: rows.length, value: mxnFromCents(cents), withoutAmount };
}

const sortDescThen =
  <T>(count: (x: T) => number, name: (x: T) => string) =>
  (a: T, b: T): number =>
    count(b) - count(a) || name(a).localeCompare(name(b), 'es');

const collapse = (s: string): string => s.trim().replace(/\s+/g, ' ');
/** Clave de agrupación: sin mayúsculas, acentos ni espacios repetidos. */
const zoneKey = (s: string): string =>
  collapse(s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/**
 * Agrupa los estados (`undefined` = CP sin dato). Nombres que solo difieren en mayúsculas, acentos o
 * espacios cuentan juntos y se muestra la forma más frecuente. Se muestran las primeras
 * `ZONES_SHOWN` y el resto se suma en «Otros»: un dato sucio nunca rebasa el límite del esquema.
 */
function groupZones(estados: readonly (string | undefined)[]): { estado: string; count: number }[] {
  const groups = new Map<string, { count: number; forms: Map<string, number> }>();
  let noData = 0;
  for (const raw of estados) {
    const shown = raw === undefined ? '' : collapse(raw);
    if (shown === '') {
      noData += 1;
      continue;
    }
    const key = zoneKey(shown);
    const g = groups.get(key) ?? { count: 0, forms: new Map<string, number>() };
    g.count += 1;
    g.forms.set(shown, (g.forms.get(shown) ?? 0) + 1);
    groups.set(key, g);
  }
  const sorted = [...groups.values()]
    .map((g) => ({
      count: g.count,
      estado: [...g.forms.entries()].sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es'),
      )[0]![0],
    }))
    .sort(
      sortDescThen(
        (z) => z.count,
        (z) => z.estado,
      ),
    );
  const out = sorted.slice(0, ZONES_SHOWN);
  const rest = sorted.slice(ZONES_SHOWN).reduce((n, z) => n + z.count, 0);
  if (rest > 0) out.push({ estado: OTHER_ZONES_LABEL, count: rest });
  if (noData > 0) out.push({ estado: NO_ZONE_LABEL, count: noData });
  return out;
}

export function computeMetrics(input: MetricsInput): ComputedMetrics {
  const nowMs = toMs(input.now);
  const quotes = eligible(input.quotes, nowMs);
  const monthStart = localStartOfMonth(nowMs);
  const windowStart = nowMs - WINDOW_DAYS * DAY_MS;
  const inMonth = (t: number | null): boolean => t !== null && t >= monthStart && t <= nowMs;
  const created = (q: Quote): number => Date.parse(q.createdAt);

  // Por atender (nueva + en revisión) y esperando respuesta (+ cotizada), de cualquier antigüedad.
  const open = quotes.filter((q) => q.status === 'nueva' || q.status === 'en_revision');
  const nuevas = open.filter((q) => q.status === 'nueva').length;
  const waiting = quotes.filter((q) => WAITING_STATUSES.includes(q.status));
  const waitingSorted = [...waiting].sort(
    (a, b) => created(a) - created(b) || a.folio.localeCompare(b.folio),
  );

  // Eventos del mes.
  const inMonthBy = (stage: string): Quote[] =>
    quotes.filter((q) => hasEventInMonth(q, stage, monthStart, nowMs));
  const quotedRows = inMonthBy('cotizada');
  const wonRows = inMonthBy('ganada');

  // Respuesta: respuestas dadas en el mes (respondedAt), en horas corridas.
  let responseMs = 0;
  let sampleSize = 0;
  for (const q of quotes) {
    if (q.respondedAt === undefined) continue;
    const r = Date.parse(q.respondedAt);
    if (!inMonth(r) || r < created(q)) continue;
    responseMs += r - created(q);
    sampleSize += 1;
  }
  // La meta se evalúa con el promedio SIN redondear: 47.96 h se muestra «48 h» pero cumple (< 48).
  const rawAverage = sampleSize === 0 ? null : responseMs / sampleSize / HOUR_MS;
  const averageHours = rawAverage === null ? null : Math.round(rawAverage * 10) / 10;
  // Pendientes = las del mes que siguen esperando respuesta (el mismo conjunto de «esperando»).
  const pendingCount = waiting.filter(
    (q) => q.respondedAt === undefined && inMonth(created(q)),
  ).length;

  // Solicitudes por semana (createdAt, semanas de lunes, la última es la actual).
  const firstWeek = addLocalDays(localStartOfWeek(nowMs), -7 * (WEEKS_SHOWN - 1));
  const weekly = Array.from({ length: WEEKS_SHOWN }, (_, i) => {
    const start = addLocalDays(firstWeek, 7 * i);
    const end = addLocalDays(start, 7);
    return {
      start: localDateString(start),
      label: localShortLabel(start),
      count: quotes.filter((q) => created(q) >= start && created(q) < end).length,
    };
  });

  // Ventana de 30 días: piedras y zonas.
  const recent = quotes.filter((q) => created(q) >= windowStart);
  const stones = new Map<string, { nombre: string; count: number }>();
  for (const q of recent) {
    for (const item of q.items) {
      const cur = stones.get(item.stoneId);
      if (cur) cur.count += 1;
      else stones.set(item.stoneId, { nombre: item.nombre, count: 1 });
    }
  }
  const topStones = [...stones.entries()]
    .map(([stoneId, v]) => ({ stoneId, nombre: v.nombre, count: v.count }))
    .sort(
      sortDescThen(
        (s) => s.count,
        (s) => s.nombre,
      ),
    )
    .slice(0, TOP_STONES_LIMIT);

  const zones = groupZones(recent.map((q) => input.zoneByCp[q.works.codigoPostal]));

  // Embudo del mes: solicitudes distintas por etapa, según el evento dentro del mes.
  const funnelCounts: Record<FunnelStage, number> = {
    nuevas: quotes.filter((q) => inMonth(created(q))).length,
    en_revision: inMonthBy('en_revision').length,
    cotizadas: quotedRows.length,
    enviadas: inMonthBy('enviada').length,
    ganadas: wonRows.length,
    perdidas: inMonthBy('perdida').length,
  };

  const alertMs = WAITING_ALERT_HOURS * HOUR_MS;
  return {
    cards: {
      pending: { total: open.length, nuevas, enRevision: open.length - nuevas },
      quoted: amountCard(quotedRows),
      won: amountCard(wonRows),
      response: {
        averageHours,
        sampleSize,
        pendingCount,
        targetHours: RESPONSE_TARGET_HOURS,
        withinTarget: rawAverage === null ? null : rawAverage < RESPONSE_TARGET_HOURS,
      },
    },
    weekly,
    topStones,
    funnel: FUNNEL_STAGES.map((s) => ({ ...s, count: funnelCounts[s.stage] })),
    zones,
    waiting: {
      items: waitingSorted.slice(0, WAITING_LIMIT).map((q) => ({
        quoteId: q.quoteId,
        folio: q.folio,
        status: q.status as 'nueva' | 'en_revision' | 'cotizada',
        cliente: q.customer.nombre,
        lugar: q.works.lugar,
        createdAt: q.createdAt,
        ageHours: Math.floor((nowMs - created(q)) / HOUR_MS),
        overdue: nowMs - created(q) > alertMs,
      })),
      total: waiting.length,
      overdueCount: waiting.filter((q) => nowMs - created(q) > alertMs).length,
    },
  };
}

/**
 * CP distintos de las solicitudes de la ventana de zonas (últimos 30 días), con tope. Sirve para
 * pedir a `PostalCodes` solo lo necesario. `capped` = había más CP que el tope.
 */
export function zonePostalCodes(
  quotes: readonly Quote[],
  now: number | Date,
  max: number,
): { codes: string[]; capped: boolean } {
  const nowMs = toMs(now);
  const windowStart = nowMs - WINDOW_DAYS * DAY_MS;
  const set = new Set<string>();
  for (const q of eligible(quotes, nowMs)) {
    if (Date.parse(q.createdAt) >= windowStart) set.add(q.works.codigoPostal);
  }
  const all = [...set];
  return { codes: all.slice(0, max), capped: all.length > max };
}

/**
 * Valida filas de DynamoDB con `quoteSchema` (quitando antes las claves de índice). Las inválidas
 * se omiten sin lanzar; `invalidIds` trae solo su `quoteId` (o `null`): nunca datos del cliente.
 */
export function parseQuoteRows(rows: readonly unknown[]): {
  quotes: Quote[];
  invalidIds: (string | null)[];
} {
  const quotes: Quote[] = [];
  const invalidIds: (string | null)[] = [];
  for (const raw of rows) {
    const obj =
      typeof raw === 'object' && raw !== null && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : null;
    const parsed = obj === null ? null : quoteSchema.safeParse(stripStorageKeys(obj));
    if (parsed?.success) quotes.push(parsed.data);
    else invalidIds.push(typeof obj?.['quoteId'] === 'string' ? obj['quoteId'] : null);
  }
  return { quotes, invalidIds };
}

import { z } from 'zod';
import { FUNNEL_STAGES, TOP_STONES_LIMIT, WAITING_LIMIT, WEEKS_SHOWN } from './compute';
import { isoDate } from '../quote/schema';
import { MEXICO_CITY_TIMEZONE } from './time';

// Respuesta de `GET /admin/metrics` (CLAUDE.md 5.3 y 8). La comparten la Lambda (arma la respuesta)
// y el dashboard (la valida al recibirla). Todo `strictObject`: si una clave de más se colara
// (p. ej. datos del cliente), el contrato se rompe en vez de filtrarse en silencio.
// Únicos datos personales permitidos: folio, nombre del cliente y obra del bloque «esperando».

const count = z.number().int().min(0);
const mxn = z.number().finite().min(0);

const amountCard = z.strictObject({ count, value: mxn, withoutAmount: count });

const funnelStageIds = FUNNEL_STAGES.map((s) => s.stage) as [string, ...string[]];

export const metricsResponseSchema = z.strictObject({
  generatedAt: isoDate('generatedAt'),
  timezone: z.literal(MEXICO_CITY_TIMEZONE),
  /** Rango de `createdAt` que se consultó (límites de la carga, no de cada tarjeta). */
  range: z.strictObject({ from: isoDate('from'), to: isoDate('to') }),
  /** Se alcanzó el tope de filas/páginas: las cifras pueden estar incompletas. */
  truncated: z.boolean(),
  /** Hubo CP sin resolver por tope o por claves sin procesar: «Sin dato» puede estar inflado. */
  zonesPartial: z.boolean(),
  /** Filas que ya no validan con el esquema de solicitud (se omitieron). */
  skipped: count,
  cards: z.strictObject({
    pending: z.strictObject({ total: count, nuevas: count, enRevision: count }),
    quoted: amountCard,
    won: amountCard,
    response: z.strictObject({
      averageHours: z.number().finite().min(0).nullable(),
      sampleSize: count,
      pendingCount: count,
      targetHours: z.number().positive(),
      withinTarget: z.boolean().nullable(),
    }),
  }),
  weekly: z
    .array(
      z.strictObject({
        start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        label: z.string().min(1).max(10),
        count,
      }),
    )
    .length(WEEKS_SHOWN),
  topStones: z
    .array(
      z.strictObject({
        stoneId: z.string().min(1).max(64),
        nombre: z.string().min(1).max(120),
        count,
      }),
    )
    .max(TOP_STONES_LIMIT),
  funnel: z
    .array(
      z.strictObject({
        stage: z.enum(funnelStageIds),
        label: z.string().min(1).max(30),
        count,
      }),
    )
    .length(FUNNEL_STAGES.length),
  zones: z.array(z.strictObject({ estado: z.string().min(1).max(80), count })).max(100),
  waiting: z.strictObject({
    items: z
      .array(
        z.strictObject({
          quoteId: z.string().min(1).max(64),
          folio: z.string().min(1).max(20),
          status: z.enum(['nueva', 'en_revision', 'cotizada']),
          cliente: z.string().min(1).max(120),
          lugar: z.string().min(1).max(200),
          createdAt: isoDate('createdAt'),
          ageHours: count,
          overdue: z.boolean(),
        }),
      )
      .max(WAITING_LIMIT),
    total: count,
    overdueCount: count,
  }),
});
export type MetricsResponse = z.infer<typeof metricsResponseSchema>;

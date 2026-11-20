import { z } from 'zod';
import { text, textOrEmpty } from '../catalog/common';
import { SOLD_BY_UNITS } from '../catalog/stone';
import { MAX_ITEMS, MAX_ITEM_QUANTITY } from '../freight/weight';
import { QuoteStatusSchema } from '../quote-status';
import { ULID_PATTERN } from './ulid';

// Solicitud de cotización (CLAUDE.md 6.2 `Quotes`, 5.4 y 5.5). Dominio puro.
// Dinero: MXN con a lo más 2 decimales; el servidor calcula en centavos enteros (ver totals.ts).

export const LOST_REASONS = [
  'precio_piedra',
  'precio_flete',
  'tiempo_entrega',
  'otro_proveedor',
  'sin_respuesta',
  'otro',
] as const;
export type LostReason = (typeof LOST_REASONS)[number];

/** Notas y historial acotados: DynamoDB limita un ítem a 400 KB. Las notas dejan margen al historial. */
export const MAX_HISTORY = 200;
export const MAX_NOTES = 100;
export const MAX_NOTE_LENGTH = 2000;
export const DEFAULT_VIGENCIA_DIAS = 15;
/** Vigencia lógica del candado de envío: pasado este tiempo un envío colgado se puede reintentar. */
export const SEND_LOCK_TTL_MS = 5 * 60 * 1000;

export const FOLIO_PATTERN = /^CN-\d{4}-\d{5}$/;

export function formatFolio(year: number, n: number): string {
  if (!Number.isInteger(year) || year < 2000 || year > 9999) throw new RangeError('Año inválido.');
  if (!Number.isInteger(n) || n < 1 || n > 99_999)
    throw new RangeError('Número de folio inválido.');
  return `CN-${year}-${String(n).padStart(5, '0')}`;
}

// Fecha ISO en UTC con milisegundos (`toISOString()`): así el orden alfabético = orden cronológico,
// que es lo que usan las claves de ordenamiento de los índices.
const ISO_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const isoDate = (label: string) =>
  z
    .string({ error: `${label} debe ser una fecha ISO` })
    .regex(ISO_MS_RE, `${label} debe ser una fecha ISO en UTC con milisegundos`)
    .refine((s) => !Number.isNaN(Date.parse(s)), `${label} no es una fecha válida`);

function mxn(label: string, max: number) {
  return z
    .number({ error: `${label} debe ser un número` })
    .finite(`${label} debe ser un número finito`)
    .min(0, `${label} no puede ser negativo`)
    .max(max, `${label} es demasiado grande`)
    .refine(
      (n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6,
      `${label} admite máximo 2 decimales`,
    );
}
const storedMoney = (label: string) => mxn(label, 1_000_000_000_000);
/** Precio unitario y flete que captura el dueño. */
const inputMoney = (label: string) => mxn(label, 1_000_000);

const quoteIdSchema = z
  .string({ error: 'El id debe ser texto' })
  .regex(ULID_PATTERN, 'El id no es un ULID válido');
const statusSchema = QuoteStatusSchema;
const unitSchema = z.enum(SOLD_BY_UNITS, { error: 'La unidad no es válida' });
const nonNegative = (label: string, max: number) =>
  z
    .number({ error: `${label} debe ser un número` })
    .finite()
    .min(0, `${label} no puede ser negativo`)
    .max(max, `${label} es demasiado grande`);

export const quoteItemSchema = z.strictObject({
  stoneId: text(64, 'La piedra'),
  nombre: text(120, 'El nombre de la piedra'),
  acabado: textOrEmpty(80, 'El acabado'),
  cantidad: z
    .number()
    .finite()
    .positive('La cantidad debe ser mayor que 0')
    .max(MAX_ITEM_QUANTITY, 'La cantidad es demasiado grande'),
  unidad: unitSchema,
  pesoKg: nonNegative('El peso', 1_000_000),
});

const freightSnapshotSchema = z.strictObject({
  estimadoMin: storedMoney('El estimado mínimo'),
  estimadoMax: storedMoney('El estimado máximo'),
  moneda: z.literal('MXN'),
  pesoTotalKg: nonNegative('El peso total', 1_000_000),
  distanciaKm: nonNegative('La distancia', 10_000),
  camion: text(80, 'El camión'),
  viajes: z.number().int().min(1).max(100),
  versionTarifa: text(40, 'La versión de tarifas'),
  calculadoAt: isoDate('calculadoAt'),
});

const vigenciaSchema = z
  .number({ error: 'La vigencia debe ser un número' })
  .int('La vigencia debe ser un número entero de días')
  .min(1, 'La vigencia mínima es 1 día')
  .max(365, 'La vigencia máxima es 365 días');

export const finalQuoteSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        stoneId: text(64, 'La piedra'),
        precioUnitario: storedMoney('El precio unitario'),
        subtotal: storedMoney('El subtotal'),
      }),
    )
    .min(1)
    .max(MAX_ITEMS),
  fleteFinal: storedMoney('El flete final'),
  subtotal: storedMoney('El subtotal'),
  /** IVA pendiente de definir (CLAUDE.md 5.5): `null` = no aplica. */
  iva: storedMoney('El IVA').nullable(),
  ivaPct: z.number().min(0).max(100).nullable(),
  total: storedMoney('El total'),
  vigenciaDias: vigenciaSchema,
  /** La fija la acción de envío (3.3b). */
  enviadaAt: isoDate('enviadaAt').optional(),
});
export type FinalQuote = z.infer<typeof finalQuoteSchema>;

export const HISTORY_TYPES = ['estado', 'nota', 'correo', 'edicion'] as const;
export const historyEntrySchema = z.strictObject({
  at: isoDate('at'),
  by: text(128, 'El autor'),
  tipo: z.enum(HISTORY_TYPES),
  de: statusSchema.optional(),
  a: statusSchema.optional(),
  texto: z.string().max(300).optional(),
});
export type HistoryEntry = z.infer<typeof historyEntrySchema>;

export const noteSchema = z.strictObject({
  at: isoDate('at'),
  by: text(128, 'El autor'),
  texto: text(MAX_NOTE_LENGTH, 'La nota'),
});

export const quoteSchema = z.strictObject({
  quoteId: quoteIdSchema,
  folio: z.string().regex(FOLIO_PATTERN, 'El folio no es válido'),
  createdAt: isoDate('createdAt'),
  status: statusSchema,
  customer: z.strictObject({
    nombre: text(120, 'El nombre'),
    telefono: z.string().min(5).max(30),
    correo: z.email({ error: 'El correo no es válido' }).max(254),
  }),
  works: z.strictObject({
    lugar: text(200, 'El lugar de la obra'),
    codigoPostal: z.string().regex(/^\d{5}$/, 'El código postal debe tener 5 dígitos'),
    uso: textOrEmpty(200, 'El uso'),
    notas: textOrEmpty(2000, 'Las notas'),
  }),
  // Una fila por piedra: el precio final se captura por piedra (5.5).
  items: z
    .array(quoteItemSchema)
    .min(1, 'Agrega al menos una piedra')
    .max(MAX_ITEMS)
    .refine(
      (xs) => new Set(xs.map((i) => i.stoneId)).size === xs.length,
      'Las piedras no pueden repetirse',
    ),
  freight: freightSnapshotSchema.optional(),
  finalQuote: finalQuoteSchema.optional(),
  history: z.array(historyEntrySchema).max(MAX_HISTORY),
  notes: z.array(noteSchema).max(MAX_NOTES),
  lostReason: z.enum(LOST_REASONS).optional(),
  respondedAt: isoDate('respondedAt').optional(),
  /**
   * Candado de envío: lo pone y lo quita SOLO el servidor (el cliente nunca lo manda: ningún cuerpo
   * de PATCH, notas o envío lo admite). Mientras exista y no pase `SEND_LOCK_TTL_MS` bloquea
   * PATCH, notas y otro envío (409 `send_in_progress`).
   */
  sendLock: z.strictObject({ at: isoDate('at'), by: text(128, 'El autor') }).optional(),
  consentAt: isoDate('consentAt'),
  source: z
    .strictObject({
      userAgent: z.string().max(200).optional(),
      referrer: z.string().max(300).optional(),
    })
    .optional(),
  /** Versión para concurrencia optimista (empieza en 1). */
  rev: z.number().int().min(1),
  ejemplo: z.boolean().optional(),
});
export type Quote = z.infer<typeof quoteSchema>;

/** Atributos de almacenamiento que no son parte del dominio (índices y búsqueda). */
export const STORAGE_KEYS = ['gsi1pk', 'gsi1sk', 'gsi2pk', 'gsi2sk', 'searchKey'] as const;

export function stripStorageKeys(raw: Record<string, unknown>): Record<string, unknown> {
  const out = { ...raw };
  for (const k of STORAGE_KEYS) delete out[k];
  return out;
}

const revSchema = z
  .number({ error: 'rev es obligatorio y debe ser un número' })
  .int('rev debe ser un entero')
  .min(1, 'rev debe ser mayor o igual a 1');

/** Estados que el PATCH puede fijar: `enviada` solo con la acción de envío; `nueva` nunca. */
const PATCH_STATUSES = ['en_revision', 'cotizada', 'ganada', 'perdida', 'cancelada'] as const;

export const patchBodySchema = z
  .strictObject({
    status: z
      .enum(PATCH_STATUSES, { error: 'El estado no se puede fijar por esta vía' })
      .optional(),
    lostReason: z.enum(LOST_REASONS, { error: 'El motivo de pérdida no es válido' }).optional(),
    // El cliente NUNCA envía subtotales ni total: solo precios, flete y vigencia.
    finalQuote: z
      .strictObject({
        items: z
          .array(
            z.strictObject({
              stoneId: text(64, 'La piedra'),
              precioUnitario: inputMoney('El precio unitario'),
            }),
          )
          .min(1, 'Captura el precio de cada piedra')
          .max(MAX_ITEMS)
          .refine(
            (xs) => new Set(xs.map((i) => i.stoneId)).size === xs.length,
            'Las piedras no pueden repetirse',
          ),
        fleteFinal: inputMoney('El flete final'),
        vigenciaDias: vigenciaSchema.default(DEFAULT_VIGENCIA_DIAS),
      })
      .optional(),
    rev: revSchema,
  })
  .superRefine((b, ctx) => {
    if (b.status === undefined && b.finalQuote === undefined) {
      ctx.addIssue({ code: 'custom', path: [], message: 'No hay ningún cambio que guardar' });
    }
    if (b.status === 'perdida' && b.lostReason === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['lostReason'],
        message: 'El motivo de pérdida es obligatorio',
      });
    }
    if (b.lostReason !== undefined && b.status !== 'perdida') {
      ctx.addIssue({
        code: 'custom',
        path: ['lostReason'],
        message: 'El motivo solo aplica al estado perdida',
      });
    }
    if (b.status === 'cotizada' && b.finalQuote === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['finalQuote'],
        message: 'Para cotizar captura los precios y el flete',
      });
    }
  });
export type PatchBody = z.infer<typeof patchBodySchema>;

/** Cuerpo de `POST /admin/quotes/{quoteId}/send`: solo `rev` (el correo sale de lo ya guardado). */
export const sendBodySchema = z.strictObject({ rev: revSchema });

export const noteBodySchema = z.strictObject({
  texto: text(MAX_NOTE_LENGTH, 'La nota'),
  rev: revSchema,
});
export type NoteBody = z.infer<typeof noteBodySchema>;

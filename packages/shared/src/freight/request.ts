import { z } from 'zod';
import { SOLD_BY_UNITS } from '../catalog/stone';
import { MAX_ITEMS, MAX_ITEM_QUANTITY } from './weight';

// Validación del cuerpo del simulador de flete (frontera con datos no confiables).
// Mensajes en español que no reproducen lo enviado. El peso NUNCA viene del navegador.

/** Convierte cualquier error de zod en un mensaje en español (sin eco de datos). */
const objectErrors = (label: string, adjective: 'válido' | 'válida' = 'válido') => ({
  error: (iss: { code: string }) =>
    iss.code === 'unrecognized_keys'
      ? `${label} trae campos no permitidos`
      : `${label} no es ${adjective}`,
});

export const freightItemRequestSchema = z.strictObject(
  {
    stoneId: z
      .string({ error: 'La piedra debe ser texto' })
      .min(1, 'La piedra es obligatoria')
      .max(64, 'La piedra no es válida'),
    cantidad: z
      .number({ error: 'La cantidad debe ser un número' })
      .finite('La cantidad debe ser un número finito')
      .positive('La cantidad debe ser mayor que 0')
      .max(MAX_ITEM_QUANTITY, 'La cantidad es demasiado grande'),
    unidad: z.enum(SOLD_BY_UNITS, { error: 'La unidad no es válida' }),
    espesorCm: z
      .number({ error: 'El espesor debe ser un número' })
      .finite('El espesor debe ser un número finito')
      .positive('El espesor debe ser mayor que 0')
      .optional(),
  },
  objectErrors('Cada renglón'),
);

/** Renglones del simulador: los usan `parseFreightSimulateRequest` y, vía este módulo, el dashboard. */
const itemsSchema = z
  .array(freightItemRequestSchema, { error: 'Los renglones deben ser una lista' })
  .min(1, 'Agrega al menos una piedra')
  .max(MAX_ITEMS, `Máximo ${MAX_ITEMS} renglones`);

const postalCode = z
  .string({ error: 'El código postal debe ser texto' })
  .regex(/^\d{5}$/, 'El código postal debe tener 5 dígitos');

/** Cuerpo de `POST /admin/freight/simulate`: trae `distanciaKm` y el CP es opcional. */
export const freightSimulateRequestSchema = z.strictObject(
  {
    codigoPostal: postalCode.optional(),
    distanciaKm: z
      .number({ error: 'La distancia debe ser un número' })
      .finite('La distancia debe ser un número finito')
      .min(0, 'La distancia no puede ser negativa'),
    items: itemsSchema,
  },
  objectErrors('La solicitud', 'válida'),
);
export type FreightSimulateRequest = z.infer<typeof freightSimulateRequestSchema>;

export type ParseResult<T> = { ok: true; data: T } | { ok: false; errors: string[] };

function parseWith<T>(schema: z.ZodType<T>, raw: unknown): ParseResult<T> {
  const r = schema.safeParse(raw);
  if (r.success) return { ok: true, data: r.data };
  const errors = [...new Set(r.error.issues.map((i) => i.message))];
  return { ok: false, errors };
}

/** Valida el cuerpo de `POST /admin/freight/simulate`. Nunca lanza. */
export const parseFreightSimulateRequest = (raw: unknown): ParseResult<FreightSimulateRequest> =>
  parseWith(freightSimulateRequestSchema, raw);

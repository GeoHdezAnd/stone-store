import { z } from 'zod';
import { SOLD_BY_UNITS } from '../catalog/stone';
import { MAX_ITEMS, MAX_ITEM_QUANTITY, MIN_ITEM_QUANTITY } from '../freight/weight';
import { isValidRecipient } from './email';

// Cuerpo de `POST /quotes` (CLAUDE.md 5.1 y 8): frontera con datos NO confiables y sin sesión.
// Estricto: no existe ningún campo de peso, precio, nombre de piedra, folio, estado ni fecha; todo
// eso lo pone el servidor. Los mensajes van en español y NO reproducen lo enviado.

// Caracteres de control (Cc), de formato e invisibles (Cf: U+200B, U+FEFF, U+061C, U+00AD, U+180E,
// U+202E que invierte el texto...) y separadores de línea y párrafo (Zl/Zp: U+2028, U+2029). Se
// RECHAZAN (422) en lugar de limpiarse: no alteran el dato en silencio y nadie los usa para ocultar
// texto ni para imitar un renglón en el aviso al dueño. Costo asumido: tampoco se admiten U+200C y
// U+200D (necesarios en algunas escrituras y en emoji compuestos); el sitio es en español.
const CONTROL_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const NOTES_ALLOWED_CONTROL = /[\t\n\r]/g;

/** Texto de una sola línea: se recortan espacios y no admite saltos ni caracteres de control. */
function line(max: number, label: string, { required = true }: { required?: boolean } = {}) {
  const base = z
    .string({ error: `${label} debe ser texto` })
    .trim()
    .max(max, `${label} admite máximo ${max} caracteres`)
    .refine(
      (s) => !CONTROL_RE.test(s),
      `${label} no admite saltos de línea ni caracteres de control`,
    );
  return required ? base.refine((s) => s.length > 0, `${label} es obligatorio`) : base;
}

const notes = z
  .string({ error: 'Las notas deben ser texto' })
  .trim()
  .max(2000, 'Las notas admiten máximo 2000 caracteres')
  // Las notas sí pueden llevar saltos de línea y tabulaciones (\t \n \r), pero ningún otro carácter
  // de control, de formato ni separador (U+2028, U+2029, U+0085...).
  .refine(
    (s) => !CONTROL_RE.test(s.replace(NOTES_ALLOWED_CONTROL, '')),
    'Las notas contienen caracteres no permitidos',
  );

const email = z
  .string({ error: 'El correo debe ser texto' })
  .trim()
  .max(254, 'El correo admite máximo 254 caracteres')
  .pipe(z.email({ error: 'El correo no es válido' }))
  // Un solo destinatario, sin separadores ni espacios (el mismo criterio que usa el envío).
  .refine(isValidRecipient, 'El correo no es válido');

const itemSchema = z
  .strictObject(
    {
      stoneId: z
        .string({ error: 'La piedra debe ser texto' })
        .max(64, 'La piedra no es válida')
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'La piedra no es válida'),
      acabado: line(80, 'El acabado', { required: false }).optional(),
      cantidad: z
        .number({ error: 'La cantidad debe ser un número' })
        .finite('La cantidad debe ser un número finito')
        .min(MIN_ITEM_QUANTITY, `La cantidad mínima es ${MIN_ITEM_QUANTITY}`)
        .max(MAX_ITEM_QUANTITY, 'La cantidad es demasiado grande'),
      unidad: z.enum(SOLD_BY_UNITS, { error: 'La unidad no es válida' }),
      espesorCm: z
        .number({ error: 'El espesor debe ser un número' })
        .finite('El espesor debe ser un número finito')
        .positive('El espesor debe ser mayor que 0')
        .optional(),
    },
    {
      error: (iss) =>
        iss.code === 'unrecognized_keys'
          ? 'Cada piedra trae campos no permitidos'
          : 'Cada piedra no es válida',
    },
  )
  .superRefine((item, ctx) => {
    if (item.unidad === 'm2' && item.espesorCm === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['espesorCm'],
        message: 'Indica el espesor de la piedra',
      });
    }
    if (item.unidad !== 'm2' && item.espesorCm !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['espesorCm'],
        message: 'El espesor solo aplica a piedra por m²',
      });
    }
  });

export const createQuoteRequestSchema = z.strictObject({
  customer: z.strictObject({
    nombre: line(120, 'El nombre'),
    telefono: line(30, 'El teléfono').refine(
      (s) => s.length >= 5,
      'El teléfono es demasiado corto',
    ),
    correo: email,
  }),
  works: z.strictObject({
    lugar: line(200, 'El lugar de la obra'),
    codigoPostal: z
      .string({ error: 'El código postal debe ser texto' })
      .regex(/^\d{5}$/, 'El código postal debe tener 5 dígitos'),
    uso: line(200, 'El uso', { required: false }),
    notas: notes,
  }),
  items: z
    .array(itemSchema, { error: 'Las piedras deben ser una lista' })
    .min(1, 'Agrega al menos una piedra')
    .max(MAX_ITEMS, `Máximo ${MAX_ITEMS} piedras`)
    .refine(
      (xs) => new Set(xs.map((i) => i.stoneId)).size === xs.length,
      'Las piedras no pueden repetirse',
    ),
  /** Aviso de privacidad (LFPDPPP): sin aceptarlo no se guarda nada. */
  consent: z.literal(true, { error: 'Debes aceptar el aviso de privacidad' }),
  /**
   * Honeypot: un campo oculto que una persona nunca llena. Lleno NO es un error de validación (eso
   * le diría al bot que fue detectado): lo decide el handler, que responde como si hubiera guardado.
   */
  website: z.string({ error: 'El campo no es válido' }).optional(),
  turnstileToken: z
    .string({ error: 'La verificación anti-spam es obligatoria' })
    .min(1, 'La verificación anti-spam es obligatoria')
    .max(2048, 'La verificación anti-spam no es válida'),
});
export type CreateQuoteRequest = z.infer<typeof createQuoteRequestSchema>;

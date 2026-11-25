import { z } from 'zod';
import { text } from '../catalog/common';

// Códigos postales (CLAUDE.md 6.2 `PostalCodes`): de aquí salen las coordenadas del destino del
// flete. Dominio puro: sin I/O. Los datos que trae el repo son de EJEMPLO, no de SEPOMEX.

// Caja envolvente de México (con margen): atrapa coordenadas invertidas (lng, lat) o de otro país
// antes de que lleguen a una llamada de pago de rutas.
const MX_LAT_MIN = 14;
const MX_LAT_MAX = 33;
const MX_LNG_MIN = -118;
const MX_LNG_MAX = -86;

export const postalCodeSchema = z.strictObject({
  cp: z
    .string({ error: 'El código postal debe ser texto' })
    .regex(/^\d{5}$/, 'El código postal debe tener 5 dígitos'),
  estado: text(80, 'El estado'),
  municipio: text(120, 'El municipio'),
  colonia: text(120, 'La colonia'),
  lat: z
    .number({ error: 'La latitud debe ser un número' })
    .min(MX_LAT_MIN, 'La latitud debe estar dentro de México')
    .max(MX_LAT_MAX, 'La latitud debe estar dentro de México'),
  lng: z
    .number({ error: 'La longitud debe ser un número' })
    .min(MX_LNG_MIN, 'La longitud debe estar dentro de México')
    .max(MX_LNG_MAX, 'La longitud debe estar dentro de México'),
});
export type PostalCode = z.infer<typeof postalCodeSchema>;

/** Sobre de `content/postal-codes.json`: marca explícita de datos de ejemplo. */
export const postalCodeFileSchema = z.strictObject({
  ejemplo: z.literal(true, { error: 'El archivo debe estar marcado con "ejemplo": true' }),
  aviso: text(300, 'El aviso'),
  items: z
    .array(postalCodeSchema, { error: 'items debe ser una lista' })
    .min(1, 'Debe haber al menos un código postal')
    .max(5000, 'Demasiados códigos postales')
    .refine(
      (xs) => new Set(xs.map((x) => x.cp)).size === xs.length,
      'Los códigos postales no pueden repetirse',
    ),
});
export type PostalCodeFile = z.infer<typeof postalCodeFileSchema>;

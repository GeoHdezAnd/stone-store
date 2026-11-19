import { z } from 'zod';
import { idSchema, text, textOrEmpty } from '../catalog/common';

// Configuración de flete (CLAUDE.md 6.2 `FreightConfig`). Valores monetarios en MXN con a lo
// más 2 decimales; el cálculo los convierte a centavos enteros (ver `toCents`).

/** MXN con a lo más 2 decimales, finito, entre `min` y 1 000 000. */
function money(label: string, min: number, strictlyPositive: boolean) {
  const base = z
    .number({ error: `${label} debe ser un número` })
    .finite(`${label} debe ser un número finito`)
    .max(1_000_000, `${label} es demasiado grande`)
    .refine(
      (n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6,
      `${label} admite máximo 2 decimales`,
    );
  return strictlyPositive
    ? base.refine((n) => n > min, `${label} debe ser mayor que ${min}`)
    : base.refine((n) => n >= min, `${label} no puede ser menor que ${min}`);
}

export const truckSchema = z.strictObject({
  id: idSchema,
  nombre: text(80, 'El nombre del camión'),
  capacidadKg: z
    .number({ error: 'La capacidad debe ser un número' })
    .finite('La capacidad debe ser un número finito')
    .positive('La capacidad debe ser mayor que 0')
    .max(100_000, 'La capacidad es demasiado grande'),
  /** Tarifa base por viaje (puede ser 0). */
  base: money('La tarifa base', 0, false),
  porKm: money('La tarifa por km', 0, true),
  minimo: money('La tarifa mínima', 0, true),
});
export type Truck = z.infer<typeof truckSchema>;

export const freightConfigSchema = z.strictObject({
  /** Identificador de versión (p. ej. `v12` o `2026-11-01`). */
  version: text(40, 'La versión'),
  /** Derivada: la fija el repositorio (fila ACTIVE); opcional en la entrada. */
  activa: z.boolean({ error: 'activa debe ser verdadero o falso' }).optional(),
  /** Marca de datos de ejemplo (no reales). */
  ejemplo: z.boolean({ error: 'ejemplo debe ser verdadero o falso' }).optional(),
  origen: z.strictObject({
    lat: z
      .number({ error: 'La latitud debe ser un número' })
      .min(-90, 'Latitud no válida')
      .max(90, 'Latitud no válida'),
    lng: z
      .number({ error: 'La longitud debe ser un número' })
      .min(-180, 'Longitud no válida')
      .max(180, 'Longitud no válida'),
    nombre: text(120, 'El nombre del origen'),
  }),
  camiones: z
    .array(truckSchema, { error: 'Los camiones deben ser una lista' })
    .min(1, 'Debe haber al menos un camión')
    .max(10, 'Máximo 10 camiones')
    .refine(
      (xs) => new Set(xs.map((t) => t.id)).size === xs.length,
      'Los ids de camión no pueden repetirse',
    ),
  /** Fracción ±: 0.1 = ±10 %. */
  margenRango: z
    .number({ error: 'El margen debe ser un número' })
    .min(0, 'El margen mínimo es 0')
    .max(1, 'El margen máximo es 1 (100 %)'),
  recargoDescarga: money('El recargo de descarga', 0, false),
  /** Merma y embalaje en porcentaje del peso (5 = +5 %). */
  mermaPct: z
    .number({ error: 'La merma debe ser un número' })
    .min(0, 'La merma mínima es 0 %')
    .max(50, 'La merma máxima es 50 %'),
  /** Si es true, cada viaje se cobra ida y vuelta (×2). El recargo de descarga no se duplica. */
  idaYVuelta: z.boolean({ error: 'idaYVuelta debe ser verdadero o falso' }).default(false),
  /** Prefijos de CP (2 a 5 dígitos) que se cubren. */
  zonasCubiertas: z
    .array(z.string().regex(/^\d{2,5}$/, 'Cada zona debe ser un prefijo de CP de 2 a 5 dígitos'), {
      error: 'Las zonas deben ser una lista',
    })
    .min(1, 'Debe haber al menos una zona cubierta')
    .max(500, 'Demasiadas zonas')
    .refine((xs) => new Set(xs).size === xs.length, 'Las zonas no pueden repetirse'),
  maxKm: z
    .number({ error: 'La distancia máxima debe ser un número' })
    .finite('La distancia máxima debe ser finita')
    .positive('La distancia máxima debe ser mayor que 0')
    .max(10_000, 'La distancia máxima es demasiado grande'),
  creadaPor: text(120, 'El autor'),
  creadaAt: z.iso.datetime({ offset: true, error: 'creadaAt debe ser una fecha ISO válida' }),
  resumenCambio: textOrEmpty(500, 'El resumen del cambio'),
});

export type FreightConfig = z.infer<typeof freightConfigSchema>;
export type FreightConfigInput = z.input<typeof freightConfigSchema>;

/** MXN -> centavos enteros (evita errores de coma flotante al sumar/multiplicar). */
export function toCents(mxn: number): number {
  return Math.round(mxn * 100);
}

/**
 * Versión de una configuración de flete guardada: `t0001`, `t0002`... (el prefijo `t` de «tarifa»
 * la distingue de `vNNNN`, que son las publicaciones del catálogo). La fila puntero se llama
 * `ACTIVE` y NO cumple este patrón. Lista blanca de los parámetros de ruta `{version}`.
 */
export const FREIGHT_VERSION_PATTERN = /^t\d{4,}$/;

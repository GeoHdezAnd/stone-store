import { freightConfigSchema } from '@canteras/shared';
import { z } from 'zod';
import type { FormSection } from '../components/fieldTypes';

/**
 * Cuerpo de `PUT /admin/freight-config` sin `baseVersion` (lo agrega quien guarda). Refleja el
 * schema del servidor (`services/api/src/admin-freight/routes.ts`): la configuración sin lo que
 * decide el servidor, más `resumenCambio` obligatorio y `activar` opcional.
 */
export const freightFormSchema = freightConfigSchema
  .omit({ version: true, activa: true, creadaPor: true, creadaAt: true, resumenCambio: true })
  .extend({
    resumenCambio: z
      .string({ error: 'El resumen del cambio debe ser texto' })
      .min(1, 'El resumen del cambio es obligatorio')
      .max(300, 'El resumen del cambio admite máximo 300 caracteres'),
    activar: z.boolean({ error: 'activar debe ser verdadero o falso' }).optional(),
  });
export type FreightFormValues = z.infer<typeof freightFormSchema>;

const truckColumns = [
  { name: 'id', label: 'Id (slug)', kind: 'text' as const },
  { name: 'nombre', label: 'Nombre', kind: 'text' as const },
  { name: 'capacidadKg', label: 'Capacidad (kg)', kind: 'number' as const },
  { name: 'base', label: 'Tarifa base (MXN)', kind: 'number' as const },
  { name: 'porKm', label: 'Por km (MXN)', kind: 'number' as const },
  { name: 'minimo', label: 'Mínimo (MXN)', kind: 'number' as const },
];

/** Secciones del editor de tarifas. El origen vive en el borrador como tres campos de un objeto. */
export const freightSections: readonly FormSection<never>[] = [
  {
    title: 'Origen (el patio)',
    fields: [
      {
        name: 'origenNombre',
        label: 'Nombre',
        kind: 'text',
        group: { key: 'origen', prop: 'nombre' },
      },
      {
        name: 'origenLat',
        label: 'Latitud',
        kind: 'number',
        group: { key: 'origen', prop: 'lat' },
      },
      {
        name: 'origenLng',
        label: 'Longitud',
        kind: 'number',
        group: { key: 'origen', prop: 'lng' },
      },
    ],
  },
  {
    title: 'Camiones',
    fields: [
      {
        name: 'camiones',
        label: 'Camiones',
        kind: 'rows',
        labelHidden: true,
        rowFields: truckColumns,
        rowLabel: 'Camión',
        addRowLabel: 'Agregar camión',
        maxRows: 10,
      },
    ],
  },
  {
    title: 'Tarifas y reglas',
    fields: [
      {
        name: 'margenRango',
        label: 'Margen del rango (±%)',
        kind: 'number',
        scale: 100,
        hint: 'Se muestra en porcentaje y se guarda como fracción (10 % = 0.1).',
      },
      { name: 'mermaPct', label: 'Merma y embalaje (%)', kind: 'number', hint: 'De 0 a 50.' },
      { name: 'recargoDescarga', label: 'Recargo de descarga (MXN)', kind: 'number' },
      { name: 'maxKm', label: 'Distancia máxima (km)', kind: 'number' },
      {
        name: 'idaYVuelta',
        label: 'Cobrar cada viaje ida y vuelta',
        kind: 'checkbox',
        hint: 'Duplica el costo de cada viaje; el recargo de descarga no se duplica.',
      },
    ],
  },
  {
    title: 'Zonas cubiertas',
    fields: [
      {
        name: 'zonasCubiertas',
        label: 'Prefijos de código postal',
        kind: 'list',
        labelHidden: true,
        hint: 'Uno por línea, de 2 a 5 dígitos. Ej. 72 cubre todos los CP que empiezan con 72.',
      },
    ],
  },
  {
    title: 'Esta versión',
    fields: [
      {
        name: 'resumenCambio',
        label: 'Resumen del cambio',
        kind: 'text',
        hint: 'Obligatorio, máximo 300 caracteres.',
        span: 'full',
      },
      {
        name: 'ejemplo',
        label: 'Son datos de ejemplo (no reales)',
        kind: 'checkbox',
        hint: 'Mientras sea de ejemplo, las estimaciones se marcan como tales.',
      },
      {
        name: 'activar',
        label: 'Activar al guardar',
        kind: 'checkbox',
        hint: 'La primera versión queda activa sola.',
      },
    ],
  },
];

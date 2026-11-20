import {
  SOLD_BY_UNITS,
  USE_CATEGORIES,
  USE_CATEGORY_LABELS,
  stoneSchema,
  stoneWeightKgPerM2,
} from '@canteras/shared';
import type { Stone } from '@canteras/shared';
import { createElement } from 'react';
import { asStringList } from '../components/fieldTypes';
import type { Draft, FieldDef, FormSection } from '../components/fieldTypes';
import { MediaPhotoField } from './MediaPhotoField';
import { ReferenceMultiSelect } from './ReferenceMultiSelect';
import type { CatalogConfig } from './types';

const UNIT_LABELS: Record<(typeof SOLD_BY_UNITS)[number], string> = {
  m2: 'Metro cuadrado (m²)',
  pieza: 'Pieza',
  tonelada: 'Tonelada',
};

const categoryLabel = (id: string) =>
  USE_CATEGORY_LABELS[id as keyof typeof USE_CATEGORY_LABELS] ?? id;

const projectLabel = (row: { id: string; titulo?: unknown }) =>
  typeof row.titulo === 'string' ? row.titulo : row.id;

/** Reglas del schema: «pieza» exige peso por pieza y «m2» exige espesores (y usa el peso por m²). */
const sells = (unit: (typeof SOLD_BY_UNITS)[number]) => (values: Draft) =>
  asStringList(values.vendidaPor).includes(unit);

function weightHint(values: Draft): string | undefined {
  if (!sells('m2')(values)) return undefined;
  const density = Number(typeof values.densidadKgM3 === 'string' ? values.densidadKgM3 : NaN);
  if (!Number.isFinite(density) || density <= 0) return undefined;
  const kg = stoneWeightKgPerM2({ densidadKgM3: density });
  return `Peso derivado: ${kg.toLocaleString('es-MX')} kg por m² a 5 cm (densidad ÷ 100 × 5).`;
}

const f = (def: FieldDef<Stone>): FieldDef<Stone> => def;

const identification: FormSection<Stone> = {
  title: 'Identificación',
  fields: [
    f({
      name: 'id',
      label: 'Id (slug)',
      kind: 'text',
      lockedOnEdit: true,
      hint: 'Minúsculas, números y guiones. No se puede cambiar después. Ej. «cantera-rosa».',
    }),
    f({ name: 'nombre', label: 'Nombre', kind: 'text' }),
    f({ name: 'origen', label: 'Origen', kind: 'text', hint: 'Ej. Sedimentaria.' }),
    f({ name: 'tipoRoca', label: 'Tipo de roca', kind: 'text' }),
    f({
      name: 'activa',
      label: 'Activa (visible en el sitio)',
      kind: 'checkbox',
      ownerOnly: true,
    }),
  ],
};

const traits: FormSection<Stone> = {
  title: 'Características',
  fields: [
    f({ name: 'colores', label: 'Colores', kind: 'list', hint: 'Uno por línea.', span: 'half' }),
    f({
      name: 'categoriasUso',
      label: 'Categorías de uso',
      kind: 'multiselect',
      options: USE_CATEGORIES.map((value) => ({ value, label: USE_CATEGORY_LABELS[value] })),
    }),
    f({
      name: 'acabados',
      label: 'Acabados',
      kind: 'list',
      hint: 'Nombres libres (no ids), uno por línea.',
      span: 'half',
    }),
    f({
      name: 'formatos',
      label: 'Formatos',
      kind: 'list',
      hint: 'Uno por línea. Ej. Placa 60 × 40.',
      span: 'half',
    }),
    f({ name: 'absorcionPct', label: 'Absorción (%)', kind: 'number' }),
  ],
};

const sale: FormSection<Stone> = {
  title: 'Venta y peso',
  fields: [
    f({
      name: 'vendidaPor',
      label: 'Vendida por',
      kind: 'multiselect',
      options: SOLD_BY_UNITS.map((value) => ({ value, label: UNIT_LABELS[value] })),
    }),
    f({
      name: 'espesoresCm',
      label: 'Espesores (cm)',
      kind: 'number-list',
      hint: 'Enteros separados por coma. Ej. 3, 5, 8.',
      visibleWhen: sells('m2'),
    }),
    f({
      name: 'densidadKgM3',
      label: 'Densidad (kg/m³)',
      kind: 'number',
      hint: weightHint,
    }),
    f({
      name: 'pesoKgPorM2PorCm',
      label: 'Peso por m² por cm (kg)',
      kind: 'nullable-number',
      hint: 'Opcional.',
      visibleWhen: sells('m2'),
    }),
    f({
      name: 'pesoKgPorPieza',
      label: 'Peso por pieza (kg)',
      kind: 'nullable-number',
      hint: 'Obligatorio si se vende por pieza.',
      visibleWhen: sells('pieza'),
    }),
    f({
      name: 'existencia',
      label: 'Existencia',
      kind: 'text',
      hint: 'Ej. En patio o Bajo pedido.',
    }),
    f({ name: 'entregaDias', label: 'Entrega (días)', kind: 'number' }),
  ],
};

const description: FormSection<Stone> = {
  title: 'Descripción',
  fields: [f({ name: 'descripcion', label: 'Descripción', kind: 'textarea' })],
};

const photos: FormSection<Stone> = {
  title: 'Fotos',
  fields: [
    f({
      name: 'fotos',
      label: 'Fotos',
      labelHidden: true,
      kind: 'custom',
      render: (props) =>
        createElement(MediaPhotoField, {
          entity: 'stones',
          props,
          createNote: 'Guarda la piedra para poder subir fotos.',
        }),
    }),
  ],
};

const related: FormSection<Stone> = {
  title: 'Proyectos relacionados',
  fields: [
    f({
      name: 'proyectosRelacionados',
      label: 'Proyectos relacionados',
      labelHidden: true,
      kind: 'custom',
      render: (props) =>
        createElement(ReferenceMultiSelect, { segment: 'projects', labelOf: projectLabel, props }),
    }),
  ],
};

export const stonesConfig: CatalogConfig<Stone> = {
  segment: 'stones',
  title: 'Piedras',
  noun: { singular: 'piedra', plural: 'piedras', feminine: true },
  schema: stoneSchema,
  emptyEntity: () => ({
    id: '',
    nombre: '',
    origen: '',
    tipoRoca: '',
    colores: [],
    categoriasUso: [],
    acabados: [],
    formatos: [],
    espesoresCm: [],
    absorcionPct: 0,
    descripcion: '',
    existencia: '',
    entregaDias: 0,
    vendidaPor: [],
    pesoKgPorM2PorCm: null,
    pesoKgPorPieza: null,
    densidadKgM3: 0,
    fotos: [],
    proyectosRelacionados: [],
    activa: true,
  }),
  rowName: (row) => row.nombre,
  searchText: (row) => `${row.id} ${row.nombre} ${row.tipoRoca} ${row.colores.join(' ')}`,
  columns: [
    { key: 'nombre', header: 'Nombre', render: (row) => row.nombre },
    { key: 'id', header: 'Id', render: (row) => row.id },
    {
      key: 'categorias',
      header: 'Categorías',
      render: (row) => row.categoriasUso.map(categoryLabel).join(', '),
    },
    { key: 'existencia', header: 'Existencia', render: (row) => row.existencia },
  ],
  sections: [identification, traits, sale, description, photos, related],
};

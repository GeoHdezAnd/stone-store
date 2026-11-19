import { PROJECT_CATEGORIES, PROJECT_STATUSES, projectSchema } from '@canteras/shared';
import type { Project } from '@canteras/shared';
import { createElement } from 'react';
import type { FieldDef, FormSection } from '../components/fieldTypes';
import { MediaPhotoField } from './MediaPhotoField';
import { ReferenceMultiSelect } from './ReferenceMultiSelect';
import type { CatalogConfig } from './types';

const CATEGORY_LABELS: Record<(typeof PROJECT_CATEGORIES)[number], string> = {
  fachadas: 'Fachadas',
  cocinas: 'Cocinas',
  restauracion: 'Restauración',
  'jardin-exterior': 'Jardín y exterior',
  escultura: 'Escultura',
};

const STATUS_LABELS: Record<(typeof PROJECT_STATUSES)[number], string> = {
  publicado: 'Publicado',
  borrador: 'Borrador',
};

const categoryLabel = (id: string) => CATEGORY_LABELS[id as keyof typeof CATEGORY_LABELS] ?? id;
const statusLabel = (id: string) => STATUS_LABELS[id as keyof typeof STATUS_LABELS] ?? id;
const nameOf = (row: { id: string; nombre?: unknown }) =>
  typeof row.nombre === 'string' ? row.nombre : row.id;

/** Claves del borrador: las del proyecto más las partes del testimonio. */
type ProjectDraft = Project & { testimonioTexto: string; testimonioAutor: string };

const f = (def: FieldDef<Project>): FieldDef<Project> => def;

const identification: FormSection<Project> = {
  title: 'Identificación',
  fields: [
    f({
      name: 'id',
      label: 'Id (slug)',
      kind: 'text',
      lockedOnEdit: true,
      hint: 'Minúsculas, números y guiones. No se puede cambiar después. Ej. «casa-tepeyahualco».',
    }),
    f({ name: 'titulo', label: 'Título', kind: 'text' }),
    f({
      name: 'categoria',
      label: 'Categoría',
      kind: 'select',
      options: PROJECT_CATEGORIES.map((value) => ({ value, label: CATEGORY_LABELS[value] })),
    }),
    f({
      name: 'estado',
      label: 'Estado',
      kind: 'select',
      options: PROJECT_STATUSES.map((value) => ({ value, label: STATUS_LABELS[value] })),
      hint: 'Solo los proyectos publicados llegan al sitio.',
    }),
    f({
      name: 'activa',
      label: 'Activo (visible en el sitio)',
      kind: 'checkbox',
      ownerOnly: true,
    }),
  ],
};

const work: FormSection<Project> = {
  title: 'Datos de la obra',
  fields: [
    f({ name: 'ubicacion', label: 'Ubicación', kind: 'text' }),
    f({ name: 'anio', label: 'Año', kind: 'number' }),
    f({ name: 'superficie', label: 'Superficie', kind: 'text', hint: 'Opcional. Ej. 210 m².' }),
    f({ name: 'entrega', label: 'Entrega', kind: 'text', hint: 'Opcional. Ej. 6 semanas.' }),
    f({
      name: 'piezasLabradas',
      label: 'Piezas labradas',
      kind: 'nullable-number',
      hint: 'Opcional.',
    }),
  ],
};

// El testimonio es un objeto opcional: vive en el borrador como dos campos y se arma al guardar.
const testimonial = (
  def: Pick<FieldDef<ProjectDraft>, 'name' | 'label' | 'kind'> & { prop: string },
): FieldDef<ProjectDraft> => ({
  name: def.name,
  label: def.label,
  kind: def.kind,
  group: { key: 'testimonio', prop: def.prop, nullable: true },
  span: 'full',
});

const descriptionAndTestimonial: FormSection<ProjectDraft> = {
  title: 'Descripción y testimonio',
  fields: [
    f({ name: 'descripcion', label: 'Descripción', kind: 'textarea' }) as FieldDef<
      Record<string, unknown>
    >,
    testimonial({
      name: 'testimonioTexto',
      label: 'Testimonio (texto)',
      kind: 'textarea',
      prop: 'texto',
    }),
    testimonial({
      name: 'testimonioAutor',
      label: 'Testimonio (autor)',
      kind: 'text',
      prop: 'autor',
    }),
  ],
};

const references: FormSection<Project> = {
  title: 'Piedras y acabados',
  fields: [
    f({
      name: 'piedras',
      label: 'Piedras',
      kind: 'custom',
      render: (props) =>
        createElement(ReferenceMultiSelect, { segment: 'stones', labelOf: nameOf, props }),
    }),
    f({
      name: 'acabados',
      label: 'Acabados',
      kind: 'custom',
      render: (props) =>
        createElement(ReferenceMultiSelect, { segment: 'finishes', labelOf: nameOf, props }),
    }),
  ],
};

const photos: FormSection<Project> = {
  title: 'Fotos',
  fields: [
    f({
      name: 'fotos',
      label: 'Fotos',
      labelHidden: true,
      kind: 'custom',
      render: (props) =>
        createElement(MediaPhotoField, {
          entity: 'projects',
          props,
          createNote: 'Guarda el proyecto para poder subir fotos.',
        }),
    }),
  ],
};

export const projectsConfig: CatalogConfig<Project> = {
  segment: 'projects',
  title: 'Proyectos',
  noun: { singular: 'proyecto', plural: 'proyectos' },
  schema: projectSchema,
  emptyEntity: () => ({
    id: '',
    titulo: '',
    // Vacía a propósito: el formulario pide elegirla (el schema la rechaza si no se elige).
    categoria: '' as Project['categoria'],
    ubicacion: '',
    anio: 0,
    descripcion: '',
    superficie: '',
    piedras: [],
    acabados: [],
    piezasLabradas: null,
    entrega: '',
    testimonio: null,
    fotos: [],
    estado: 'borrador',
    activa: true,
  }),
  rowName: (row) => row.titulo,
  searchText: (row) => `${row.id} ${row.titulo} ${row.ubicacion} ${categoryLabel(row.categoria)}`,
  columns: [
    { key: 'titulo', header: 'Título', render: (row) => row.titulo },
    { key: 'id', header: 'Id', render: (row) => row.id },
    { key: 'categoria', header: 'Categoría', render: (row) => categoryLabel(row.categoria) },
    {
      key: 'estado',
      header: 'Publicación',
      render: (row) => (
        <span className={row.estado === 'publicado' ? 'tag tag-ink' : 'tag tag-outline'}>
          {statusLabel(row.estado)}
        </span>
      ),
    },
  ],
  sections: [identification, work, descriptionAndTestimonial, references, photos],
};

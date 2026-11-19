import type { z } from 'zod';
import type { Column } from '../components/DataTable';
import type { FieldDef } from '../components/EntityForm';
import type { Noun } from '../lib/catalogLabels';

/** Lo mínimo que comparten las entidades del catálogo. */
export interface CatalogEntity extends Record<string, unknown> {
  id: string;
  activa: boolean;
}

/** Todo lo que distingue una pantalla de catálogo de otra. El resto es código compartido. */
export interface CatalogConfig<T extends CatalogEntity> {
  /** Segmento de la API: `/admin/<segment>`. */
  segment: string;
  title: string;
  noun: Noun;
  /** Validador del formulario: el mismo schema que usa la API. */
  schema: z.ZodType<T>;
  /** Valores iniciales del alta. */
  emptyEntity: () => T;
  /** Nombre legible de una fila (diálogos, etiquetas de botones). */
  rowName: (row: T) => string;
  /** Texto en el que busca el filtro. */
  searchText: (row: T) => string;
  /** Columnas propias de la entidad (la de estado y las acciones las agrega la pantalla). */
  columns: readonly Column<T>[];
  /** Campos del formulario. `lockedOnEdit`: no se puede cambiar al editar (el id). */
  fields: ReadonlyArray<FieldDef<T> & { lockedOnEdit?: boolean; ownerOnly?: boolean }>;
}

import type { ReactNode } from 'react';

/**
 * Lo que un formulario guarda por campo mientras se edita. Los números y las listas se manejan
 * como texto y se convierten al guardar (`lib/draft.ts`), para no perder lo que se está escribiendo.
 */
export type FormValue = string | boolean | string[];
export type Draft = Record<string, FormValue>;

export type FieldKind =
  | 'text'
  | 'textarea'
  | 'checkbox'
  | 'number'
  | 'nullable-number'
  | 'select'
  /** Lista de textos, uno por línea. */
  | 'list'
  /** Lista de números separados por coma. */
  | 'number-list'
  /** Varias opciones fijas (`options`). */
  | 'multiselect'
  /** Control propio vía `render`; su valor es texto o lista de textos. */
  | 'custom';

/** Lo que recibe el `render` de un campo `custom`. */
export interface FieldRenderProps {
  inputId: string;
  name: string;
  value: FormValue;
  onChange: (value: FormValue) => void;
  disabled: boolean;
  invalid: boolean;
  describedBy: string | undefined;
  /** Borrador completo (para campos que dependen de otros, p. ej. el id). */
  values: Draft;
  mode: 'create' | 'edit';
}

export interface FieldDef<T> {
  name: Extract<keyof T, string>;
  label: string;
  kind: FieldKind;
  /** Filas del `textarea` y de `list`. */
  rows?: number;
  /** Para `select` y `multiselect`. */
  options?: readonly { value: string; label: string }[];
  /** Ayuda bajo el campo; puede depender del borrador. */
  hint?: string | ((values: Draft) => string | undefined);
  readOnly?: boolean;
  disabled?: boolean;
  /** Solo para `custom`. */
  render?: (props: FieldRenderProps) => ReactNode;
  /** No editable al modificar (p. ej. el id). */
  lockedOnEdit?: boolean;
  /** Solo el dueño puede cambiarlo. */
  ownerOnly?: boolean;
  /** Si devuelve `false` el campo no se muestra ni cuenta al guardar (se envía su valor neutro). */
  visibleWhen?: (values: Draft) => boolean;
  /** Valor que se envía al guardar si el campo está oculto. Por defecto, el neutro de su tipo. */
  hiddenValue?: unknown;
  /** Oculta la etiqueta a la vista (sigue asociada para lectores de pantalla). Útil si la sección ya la nombra. */
  labelHidden?: boolean;
  /**
   * El campo es una propiedad de un objeto anidado (p. ej. testimonio.texto). Al guardar se arma
   * el objeto; con `nullable`, si todas sus propiedades están vacías se envía `null`.
   */
  group?: { key: string; prop: string; nullable?: boolean };
  /** Ancho en la cuadrícula: `full` ocupa las dos columnas. Por defecto, según el tipo. */
  span?: 'half' | 'full';
}

/** Grupo de campos con encabezado opcional. */
export interface FormSection<T> {
  title?: string;
  description?: string;
  fields: readonly FieldDef<T>[];
}

export function flattenSections<T>(sections: readonly FormSection<T>[]): FieldDef<T>[] {
  return sections.flatMap((section) => [...section.fields]);
}

/** Nombres de los campos que se están mostrando (los ocultos por `visibleWhen` quedan fuera). */
export function visibleFieldNames<T>(fields: readonly FieldDef<T>[], values: Draft): Set<string> {
  return new Set(fields.filter((f) => !f.visibleWhen || f.visibleWhen(values)).map((f) => f.name));
}

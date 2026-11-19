import { finishSchema } from '@canteras/shared';
import type { Finish } from '@canteras/shared';
import type { CatalogConfig } from './types';

// Finish.foto no tiene editor todavía (las fotos llegan con piedras): se conserva tal cual.
export const finishesConfig: CatalogConfig<Finish> = {
  segment: 'finishes',
  title: 'Acabados',
  noun: { singular: 'acabado', plural: 'acabados' },
  schema: finishSchema,
  emptyEntity: () => ({ id: '', nombre: '', descripcion: '', foto: null, activa: true }),
  rowName: (row) => row.nombre,
  searchText: (row) => `${row.id} ${row.nombre} ${row.descripcion}`,
  columns: [
    { key: 'nombre', header: 'Nombre', render: (row) => row.nombre },
    { key: 'id', header: 'Id', render: (row) => row.id },
  ],
  sections: [
    {
      fields: [
        {
          name: 'id',
          label: 'Id (slug)',
          kind: 'text',
          lockedOnEdit: true,
          hint: 'Minúsculas, números y guiones. No se puede cambiar después. Ej. «corte-de-sierra».',
        },
        { name: 'nombre', label: 'Nombre', kind: 'text' },
        { name: 'descripcion', label: 'Descripción', kind: 'textarea' },
        {
          name: 'activa',
          label: 'Activo (visible en el sitio)',
          kind: 'checkbox',
          ownerOnly: true,
        },
      ],
    },
  ],
};

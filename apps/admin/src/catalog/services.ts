import { serviceSchema } from '@canteras/shared';
import type { Service } from '@canteras/shared';
import type { CatalogConfig } from './types';

export const servicesConfig: CatalogConfig<Service> = {
  segment: 'services',
  title: 'Servicios',
  noun: { singular: 'servicio', plural: 'servicios' },
  schema: serviceSchema,
  emptyEntity: () => ({ id: '', titulo: '', descripcion: '', activa: true }),
  rowName: (row) => row.titulo,
  searchText: (row) => `${row.id} ${row.titulo} ${row.descripcion}`,
  columns: [
    { key: 'titulo', header: 'Título', render: (row) => row.titulo },
    { key: 'id', header: 'Id', render: (row) => row.id },
  ],
  fields: [
    {
      name: 'id',
      label: 'Id (slug)',
      kind: 'text',
      lockedOnEdit: true,
      hint: 'Minúsculas, números y guiones. No se puede cambiar después. Ej. «piedra-en-bruto».',
    },
    { name: 'titulo', label: 'Título', kind: 'text' },
    { name: 'descripcion', label: 'Descripción', kind: 'textarea' },
    { name: 'activa', label: 'Activo (visible en el sitio)', kind: 'checkbox', ownerOnly: true },
  ],
};

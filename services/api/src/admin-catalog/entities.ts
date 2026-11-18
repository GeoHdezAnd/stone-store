import { finishSchema, projectSchema, serviceSchema, stoneSchema } from '@canteras/shared';
import type { z } from 'zod';
import type { CatalogItem, EntityName } from './repository';

export type { EntityName } from './repository';

export const ENTITY_NAMES = ['stone', 'project', 'finish', 'service'] as const;

/** Variable de entorno con el nombre de la tabla de cada entidad. */
export const TABLE_ENV: Readonly<Record<EntityName, string>> = {
  stone: 'STONES_TABLE',
  project: 'PROJECTS_TABLE',
  finish: 'FINISHES_TABLE',
  service: 'SERVICES_TABLE',
};

/** Campo de una entidad que apunta (por id) a otra entidad y debe existir al escribir. */
export interface ReferenceSpec {
  readonly field: string;
  readonly target: EntityName;
  pick(item: CatalogItem): readonly string[];
}

export interface EntityConfig {
  readonly name: EntityName;
  /** Segmento de la ruta: `/admin/<segment>`. */
  readonly segment: string;
  readonly schema: z.ZodType<CatalogItem>;
  /** Tipo de entidad en la auditoría (`ENTITY#<tipo>#<id>`). */
  readonly auditType: string;
  readonly references: readonly ReferenceSpec[];
}

function idsOf(item: CatalogItem, field: string): readonly string[] {
  const value = item[field];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

const ref = (field: string, target: EntityName): ReferenceSpec => ({
  field,
  target,
  pick: (item) => idsOf(item, field),
});

export const ENTITIES: Readonly<Record<EntityName, EntityConfig>> = {
  stone: {
    name: 'stone',
    segment: 'stones',
    schema: stoneSchema,
    auditType: 'stone',
    // `stone.acabados` son NOMBRES libres (CLAUDE.md 6.1): no se comprueban.
    references: [ref('proyectosRelacionados', 'project')],
  },
  project: {
    name: 'project',
    segment: 'projects',
    schema: projectSchema,
    auditType: 'project',
    references: [ref('piedras', 'stone'), ref('acabados', 'finish')],
  },
  finish: {
    name: 'finish',
    segment: 'finishes',
    schema: finishSchema,
    auditType: 'finish',
    references: [],
  },
  service: {
    name: 'service',
    segment: 'services',
    schema: serviceSchema,
    auditType: 'service',
    references: [],
  },
};

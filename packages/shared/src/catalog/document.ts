import { z } from 'zod';
import { finishSchema, type Finish } from './finish';
import { projectSchema, type Project } from './project';
import { serviceSchema, type Service } from './service';
import { publicSettingsSchema, type PublicSettings } from './settings';
import { stoneSchema, type Stone } from './stone';

// Documento `catalog.json` que el dashboard publica y el sitio público consume (CLAUDE.md 6.1).
// Dominio puro: sin I/O ni Node. El hash (sha-256) lo calcula quien llama porque `shared` no
// puede importar `node:crypto`; aquí solo se define el contenido canónico que se hashea.

/** Versión de publicación: `v0001`, `v0002`... (crece a `v10000` sin romper el patrón). */
export const CATALOG_VERSION_PATTERN = /^v\d{4,}$/;

export const catalogDocumentSchema = z.strictObject({
  version: z.string().regex(CATALOG_VERSION_PATTERN, 'Versión de catálogo no válida'),
  generatedAt: z.iso.datetime({ error: 'generatedAt debe ser una fecha ISO' }),
  // sha-256 en hexadecimal del contenido publicable (sin version ni generatedAt).
  hash: z.string().regex(/^[0-9a-f]{64}$/, 'El hash debe ser sha-256 en hexadecimal'),
  stones: z.array(stoneSchema),
  finishes: z.array(finishSchema),
  projects: z.array(projectSchema),
  services: z.array(serviceSchema),
  // Solo la fila PUBLIC de Settings: la fila MAIL (plantillas) nunca sale del dashboard.
  settings: publicSettingsSchema,
});
export type CatalogDocument = z.infer<typeof catalogDocumentSchema>;

export interface CatalogDocumentInput {
  stones: readonly Stone[];
  finishes: readonly Finish[];
  projects: readonly Project[];
  services: readonly Service[];
  publicSettings: PublicSettings;
  version: string;
  generatedAt: string;
}

/** Calcula el sha-256 (hexadecimal, 64 caracteres) de un texto. */
export type Sha256Hex = (texto: string) => string;

/**
 * JSON canónico: claves de objeto ordenadas de forma recursiva, sin espacios y sin `undefined`.
 * Dos valores equivalentes dan siempre el mismo texto (base del hash y de los bytes publicados).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

const byId = <T extends { id: string }>(a: T, b: T): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * Arma el documento publicable (función pura y determinista):
 * - solo registros `activa: true` y proyectos `estado: 'publicado'`;
 * - filtra referencias a registros que no se publican (para que el sitio no enlace a algo que
 *   no existe): `stone.proyectosRelacionados`, `project.piedras` y `project.acabados`;
 * - ordena cada lista por id (el orden de las referencias se conserva);
 * - `hash` = sha-256 de `canonicalJson` del contenido SIN `version` ni `generatedAt`, de modo que
 *   publicar dos veces lo mismo da el mismo hash («sin cambios»).
 * Valida el resultado con el esquema: si algo no cumple (p. ej. campos de la fila MAIL en
 * `publicSettings`), lanza.
 */
export function buildCatalogDocument(
  input: CatalogDocumentInput,
  sha256: Sha256Hex,
): CatalogDocument {
  const stones = input.stones.filter((s) => s.activa);
  const finishes = input.finishes.filter((f) => f.activa);
  const services = input.services.filter((s) => s.activa);
  const projects = input.projects.filter((p) => p.activa && p.estado === 'publicado');

  const stoneIds = new Set(stones.map((s) => s.id));
  const finishIds = new Set(finishes.map((f) => f.id));
  const projectIds = new Set(projects.map((p) => p.id));

  const content = {
    stones: stones
      .map((s) => ({
        ...s,
        proyectosRelacionados: s.proyectosRelacionados.filter((id) => projectIds.has(id)),
      }))
      .sort(byId),
    finishes: [...finishes].sort(byId),
    projects: projects
      .map((p) => ({
        ...p,
        piedras: p.piedras.filter((id) => stoneIds.has(id)),
        acabados: p.acabados.filter((id) => finishIds.has(id)),
      }))
      .sort(byId),
    services: [...services].sort(byId),
    settings: input.publicSettings,
  };

  const hash = sha256(canonicalJson(content));
  return catalogDocumentSchema.parse({
    version: input.version,
    generatedAt: input.generatedAt,
    hash,
    ...content,
  });
}

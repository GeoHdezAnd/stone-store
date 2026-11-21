import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  buildCatalogDocument,
  catalogDocumentSchema,
  finishSchema,
  projectSchema,
  publicSettingsSchema,
  serviceSchema,
  stoneSchema,
  type CatalogDocument,
} from '@canteras/shared';

// Loader de build (CLAUDE.md 6.1). Orden de fuentes:
//   1. `CATALOG_URL` (el `published/catalog.json` que publica el dashboard);
//   2. si no existe o falla, el seed de `content/` (datos de ejemplo).
// Corre solo en el build (Node), nunca en el navegador.

export type CatalogSource = 'url' | 'seed';

export interface LoadedCatalog {
  catalog: CatalogDocument;
  source: CatalogSource;
}

const FETCH_TIMEOUT_MS = 10_000;

const sha256 = (texto: string): string => createHash('sha256').update(texto).digest('hex');

/**
 * Deja solo lo publicable: piedras activas, proyectos `publicado` y sin referencias a registros
 * que no existen o no se publican. Reutiliza la misma función pura que usa el dashboard al
 * publicar, así que aunque el JSON venga de otra parte el sitio nunca enlaza a algo ausente.
 */
function normalize(doc: CatalogDocument): CatalogDocument {
  return buildCatalogDocument(
    {
      stones: doc.stones,
      finishes: doc.finishes,
      projects: doc.projects,
      services: doc.services,
      publicSettings: doc.settings,
      version: doc.version,
      generatedAt: doc.generatedAt,
    },
    sha256,
  );
}

async function loadFromUrl(rawUrl: string): Promise<CatalogDocument> {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('CATALOG_URL debe ser http(s)');
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`respondió HTTP ${res.status}`);
  return catalogDocumentSchema.parse(await res.json());
}

// Los archivos del seed traen un sobre `{ ejemplo, aviso, items }` (ver content/README.md).
const envelope = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item) });

async function readJson(dir: string, file: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(dir, file), 'utf8'));
}

async function loadFromSeed(): Promise<CatalogDocument> {
  // En los scripts de npm el cwd es `apps/web`; `CONTENT_DIR` permite cambiarlo.
  const dir = process.env['CONTENT_DIR'] ?? path.resolve(process.cwd(), '../../content');
  const [stones, finishes, projects, services, settings] = await Promise.all([
    readJson(dir, 'stones.json'),
    readJson(dir, 'finishes.json'),
    readJson(dir, 'projects.json'),
    readJson(dir, 'services.json'),
    readJson(dir, 'settings.json'),
  ]);
  return buildCatalogDocument(
    {
      stones: envelope(stoneSchema).parse(stones).items,
      finishes: envelope(finishSchema).parse(finishes).items,
      projects: envelope(projectSchema).parse(projects).items,
      services: envelope(serviceSchema).parse(services).items,
      // Solo la fila PUBLIC: la plantilla de correo (MAIL) no sale del dashboard.
      publicSettings: z.object({ public: publicSettingsSchema }).parse(settings).public,
      version: 'v0000',
      generatedAt: new Date().toISOString(),
    },
    sha256,
  );
}

async function load(): Promise<LoadedCatalog> {
  const url = process.env['CATALOG_URL'];
  if (url) {
    try {
      const catalog = normalize(await loadFromUrl(url));
      console.info(`[catalog] Fuente: CATALOG_URL (versión ${catalog.version})`);
      return { catalog, source: 'url' };
    } catch (error) {
      const motivo = error instanceof Error ? error.message : String(error);
      console.warn(`[catalog] CATALOG_URL falló (${motivo}); se usa el seed de content/.`);
    }
  }
  const catalog = await loadFromSeed();
  console.info('[catalog] Fuente: seed de content/ (datos de ejemplo)');
  return { catalog, source: 'seed' };
}

// Se resuelve una sola vez por build: cada página comparte la misma promesa.
let cached: Promise<LoadedCatalog> | undefined;

export function loadCatalog(): Promise<LoadedCatalog> {
  cached ??= load();
  return cached;
}

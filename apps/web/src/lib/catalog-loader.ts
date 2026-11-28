import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  buildCatalogDocument,
  CATALOG_MAX_BYTES,
  CATALOG_MIN_VERSION_ATTEMPTS,
  CATALOG_MIN_VERSION_WAIT_MS,
  catalogDocumentSchema,
  catalogSizeExceeded,
  decideCatalogVersion,
  decideUrlFailure,
  finishSchema,
  projectSchema,
  publicSettingsSchema,
  readCatalogBuildOptions,
  serviceSchema,
  stoneSchema,
  type CatalogDocument,
} from '@canteras/shared';

// Loader de build (CLAUDE.md 6.1). Orden de fuentes:
//   1. `CATALOG_URL` (el `published/catalog.json` que publica el dashboard);
//   2. si no existe o falla, el seed de `content/` (datos de ejemplo).
// Variables opcionales del build que dispara la publicación (la lógica vive en `@canteras/shared`):
//   - `CATALOG_REQUIRED=1`: si la URL falla, el build FALLA en vez de usar el seed;
//   - `CATALOG_MIN_VERSION=vNNNN`: versión mínima del catálogo (reintenta si la copia está en caché).
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

/** Lee el cuerpo con tope de bytes: se corta al pasarse, sin descargar el resto. */
async function readBodyLimited(res: Response): Promise<string> {
  if (
    res.headers.has('content-length') &&
    catalogSizeExceeded(Number(res.headers.get('content-length')))
  ) {
    throw new Error('el catálogo excede el tamaño máximo');
  }
  if (res.body === null) throw new Error('respuesta sin cuerpo');
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (catalogSizeExceeded(total, CATALOG_MAX_BYTES)) {
      throw new Error('el catálogo excede el tamaño máximo');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchCatalogOnce(url: URL): Promise<CatalogDocument> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`respondió HTTP ${res.status}`);
  return catalogDocumentSchema.parse(JSON.parse(await readBodyLimited(res)));
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function loadFromUrl(rawUrl: string, minVersion: string | null): Promise<CatalogDocument> {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('CATALOG_URL debe ser http(s)');
  }
  for (let attempt = 1; ; attempt++) {
    const doc = await fetchCatalogOnce(url);
    const decision = decideCatalogVersion({
      minVersion,
      version: doc.version,
      attempt,
      maxAttempts: CATALOG_MIN_VERSION_ATTEMPTS,
    });
    if (decision.action === 'accept') return doc;
    if (decision.action === 'fail') {
      throw new Error(`el catálogo (${doc.version}) es más viejo que ${minVersion}`);
    }
    console.warn(`[catalog] Versión ${doc.version} < ${minVersion}; reintento ${attempt}.`);
    await sleep(CATALOG_MIN_VERSION_WAIT_MS);
  }
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
  const options = readCatalogBuildOptions(process.env);
  const url = process.env['CATALOG_URL'];
  if (options.required && !url) {
    throw new Error('CATALOG_REQUIRED=1 exige definir CATALOG_URL.');
  }
  if (url) {
    try {
      const catalog = normalize(await loadFromUrl(url, options.minVersion));
      console.info(`[catalog] Fuente: CATALOG_URL (versión ${catalog.version})`);
      return { catalog, source: 'url' };
    } catch (error) {
      const motivo = error instanceof Error ? error.message : String(error);
      if (decideUrlFailure({ required: options.required }) === 'fail') {
        throw new Error(`CATALOG_REQUIRED=1: no se pudo leer CATALOG_URL (${motivo}).`, {
          cause: error,
        });
      }
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

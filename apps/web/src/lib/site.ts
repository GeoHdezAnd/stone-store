import { USE_CATEGORIES } from '@canteras/shared';
import { PROJECT_CATEGORIES } from './project';
import { loadCatalog } from './catalog-loader';

/**
 * Rutas públicas indexables, en un solo lugar para el sitemap. Excluye `/quote/` (formulario) y
 * la 404. Las categorías vacías no se listan.
 */
export async function publicPaths(): Promise<string[]> {
  const { catalog } = await loadCatalog();
  const useCategories = USE_CATEGORIES.filter((c) =>
    catalog.stones.some((s) => s.categoriasUso.includes(c)),
  );
  const projectCategories = PROJECT_CATEGORIES.filter((c) =>
    catalog.projects.some((p) => p.categoria === c),
  );
  return [
    '/',
    '/services/',
    '/catalog/',
    ...useCategories.map((c) => `/catalog/${c}/`),
    ...catalog.stones.map((s) => `/stones/${s.id}/`),
    '/finishes/',
    '/projects/',
    ...projectCategories.map((c) => `/projects/category/${c}/`),
    ...catalog.projects.map((p) => `/projects/${p.id}/`),
    '/about/',
    '/contact/',
    '/aviso-de-privacidad/',
  ];
}

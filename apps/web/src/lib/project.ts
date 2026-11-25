import type { Project } from '@canteras/shared';
import { PROJECT_CATEGORIES } from '@canteras/shared';

// Etiquetas de las categorías de proyecto (CLAUDE.md 6.1). Viven aquí porque `shared` solo
// define los slugs.
export type ProjectCategory = Project['categoria'];

export const PROJECT_CATEGORY_LABELS: Readonly<Record<ProjectCategory, string>> = {
  fachadas: 'Fachadas',
  cocinas: 'Cocinas',
  restauracion: 'Restauración',
  'jardin-exterior': 'Jardín y exterior',
  escultura: 'Escultura',
};

export { PROJECT_CATEGORIES };

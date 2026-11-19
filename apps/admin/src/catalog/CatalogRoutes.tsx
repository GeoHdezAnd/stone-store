import { Route, Routes } from 'react-router-dom';
import { CatalogEditor } from './CatalogEditor';
import { CatalogList } from './CatalogList';
import type { CatalogConfig, CatalogEntity } from './types';

/**
 * Convención de URLs de un catálogo: `/<segment>` (lista), `/<segment>/new` (alta) y
 * `/<segment>/:id` (edición). Montar con `path="<segment>/*"`. Sirve para cualquier entidad.
 */
export function CatalogRoutes<T extends CatalogEntity>({ config }: { config: CatalogConfig<T> }) {
  return (
    <Routes>
      <Route index element={<CatalogList config={config} />} />
      <Route path="new" element={<CatalogEditor config={config} />} />
      <Route path=":id" element={<CatalogEditor config={config} />} />
    </Routes>
  );
}

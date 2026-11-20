import { Route, Routes } from 'react-router-dom';
import { CatalogEditor } from './CatalogEditor';
import { CatalogList } from './CatalogList';
import type { CatalogConfig, CatalogEntity } from './types';

/**
 * Convención de URLs de un catálogo: `/<segment>` (lista), `/<segment>/new` (alta) y
 * `/<segment>/:id` (edición). Montar con `path="<segment>/*"`. Sirve para cualquier entidad.
 */
export function CatalogRoutes<T extends CatalogEntity>({ config }: { config: CatalogConfig<T> }) {
  // `key`: las 4 entidades montan este mismo componente en la misma posición del árbol, así que
  // React reutilizaría su estado al cambiar de una a otra (filas de Proyectos pintadas con las
  // columnas de Piedras). Con la clave se remonta todo el subárbol al cambiar de entidad.
  return (
    <Routes key={config.segment}>
      <Route index element={<CatalogList config={config} />} />
      <Route path="new" element={<CatalogEditor config={config} />} />
      <Route path=":id" element={<CatalogEditor config={config} />} />
    </Routes>
  );
}

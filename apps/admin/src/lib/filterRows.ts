export type ActiveFilter = 'all' | 'active' | 'inactive';

/** Filtro en cliente por texto (sin acentos ni mayúsculas) y por estado activo. */
export function filterRows<T extends { activa: boolean }>(
  rows: readonly T[],
  query: string,
  active: ActiveFilter,
  searchText: (row: T) => string,
): T[] {
  const needle = normalize(query.trim());
  return rows.filter((row) => {
    if (active === 'active' && !row.activa) return false;
    if (active === 'inactive' && row.activa) return false;
    return needle === '' || normalize(searchText(row)).includes(needle);
  });
}

function normalize(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

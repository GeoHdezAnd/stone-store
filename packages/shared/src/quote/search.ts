// Búsqueda de solicitudes: `searchKey` normalizado (minúsculas, sin acentos) y claves de índice.
// El filtro `q` se aplica con `contains(searchKey, :q)`. El correo NO entra a la clave.

export function normalizeSearchText(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

const PHONE_LIKE_RE = /^[\d\s+()-]+$/;

/**
 * Normaliza el texto de búsqueda `q`. Si parece un teléfono (solo dígitos, espacios, `+`, guiones y
 * paréntesis, y trae al menos un espacio, `+` o paréntesis) se reduce a dígitos, porque el
 * `searchKey` guarda el teléfono solo con dígitos. Un folio como `2026-00042` se deja tal cual.
 */
export function normalizeSearchQuery(value: string): string {
  const n = normalizeSearchText(value);
  if (PHONE_LIKE_RE.test(n) && /[\s+()]/.test(n)) return n.replace(/\D/g, '');
  return n;
}

export interface SearchableQuote {
  folio: string;
  customer: { nombre: string; telefono: string; correo: string };
  works: { codigoPostal: string };
}

/** folio + nombre + teléfono (solo dígitos) + CP, separados por un espacio. */
export function buildSearchKey(q: SearchableQuote): string {
  return [
    normalizeSearchText(q.folio),
    normalizeSearchText(q.customer.nombre),
    q.customer.telefono.replace(/\D/g, ''),
    q.works.codigoPostal,
  ].join(' ');
}

export const QUOTE_DATE_PARTITION = 'QUOTE';

export interface IndexedQuote extends SearchableQuote {
  quoteId: string;
  status: string;
  createdAt: string;
}

/** Atributos de almacenamiento (no son parte del dominio): claves de los dos GSI y searchKey. */
export function quoteIndexKeys(q: IndexedQuote) {
  const sk = `${q.createdAt}#${q.quoteId}`;
  return {
    gsi1pk: `STATUS#${q.status}`,
    gsi1sk: sk,
    gsi2pk: QUOTE_DATE_PARTITION,
    gsi2sk: sk,
    searchKey: buildSearchKey(q),
  };
}

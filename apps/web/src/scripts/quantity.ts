/**
 * Acepta «1500», «1500.5» y comas de miles al estilo mexicano («1,500», «1,234.5»). Todo lo demás
 * («1e3», «0x10», «1,5») da `NaN` y el esquema lo reporta como número inválido.
 */
export function parseQuantity(raw: string): number {
  let t = raw.replace(/\s+/g, '');
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, '');
  return /^\d+(\.\d+)?$/.test(t) ? Number(t) : Number.NaN;
}

import type { ApiIssue } from '../api/errors';

/** Errores por campo (clave = nombre del campo de primer nivel). `''` = error general. */
export type FieldErrors = Record<string, string>;

/** Alias `clave.propiedad` -> nombre del campo, para campos que viven en un objeto anidado. */
export type ErrorAliases = Readonly<Record<string, string>>;

function segmentsOf(path: ReadonlyArray<PropertyKey> | string): string[] {
  return typeof path === 'string'
    ? path.split(/[.[\]]+/).filter(Boolean)
    : path.map((p) => String(p));
}

/** Une issues de zod (path en arreglo) o de la API (path en texto); gana el primero por campo. */
export function toFieldErrors(
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey> | string; message: string }>,
  aliases: ErrorAliases = {},
): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of issues) {
    const segments = segmentsOf(issue.path);
    const key = aliases[segments.slice(0, 2).join('.')] ?? segments[0] ?? '';
    // Errores dentro de una fila de una lista de objetos (p. ej. camiones.0.porKm): se indica la fila.
    const rowIndex =
      segments.length >= 3 && /^\d+$/.test(segments[1] ?? '') ? Number(segments[1]) : null;
    const message = rowIndex === null ? issue.message : `Fila ${rowIndex + 1}: ${issue.message}`;
    if (!(key in errors)) errors[key] = message;
  }
  return errors;
}

export function apiIssuesToFieldErrors(
  issues: readonly ApiIssue[],
  aliases: ErrorAliases = {},
): FieldErrors {
  return toFieldErrors(issues, aliases);
}

/**
 * Separa los errores que tienen un campo visible donde pintarse de los que no (ruta raíz, objeto
 * completo, campo oculto o sin editor). Estos últimos se devuelven como un solo aviso general
 * para que el botón de guardar nunca «parezca no hacer nada».
 */
export function partitionErrors(
  errors: FieldErrors,
  visibleNames: ReadonlySet<string>,
): { field: FieldErrors; general: string | null } {
  const field: FieldErrors = {};
  const general: string[] = [];
  for (const [key, message] of Object.entries(errors)) {
    if (visibleNames.has(key)) field[key] = message;
    else general.push(message);
  }
  return {
    field,
    general: general.length > 0 ? `Hay datos que no son válidos: ${general.join(' ')}` : null,
  };
}

import type { ApiIssue } from '../api/errors';

/** Errores por campo (clave = nombre del campo de primer nivel). `''` = error general. */
export type FieldErrors = Record<string, string>;

function topField(path: string): string {
  return path.split(/[.[]/)[0] ?? '';
}

/** Une issues de zod (path en arreglo) o de la API (path en texto); gana el primero por campo. */
export function toFieldErrors(
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey> | string; message: string }>,
): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of issues) {
    const key = typeof issue.path === 'string' ? topField(issue.path) : String(issue.path[0] ?? '');
    if (!(key in errors)) errors[key] = issue.message;
  }
  return errors;
}

export function apiIssuesToFieldErrors(issues: readonly ApiIssue[]): FieldErrors {
  return toFieldErrors(issues);
}

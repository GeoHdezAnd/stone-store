export const ROLES = ['owner', 'staff'] as const;
export type Role = (typeof ROLES)[number];

/** Coincidencia EXACTA (sin normalizar mayúsculas ni espacios). */
export function isRole(x: unknown): x is Role {
  return typeof x === 'string' && (ROLES as readonly string[]).includes(x);
}

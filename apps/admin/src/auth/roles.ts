import { hasAnyRole, parseGroupsClaim, rolesFromGroups, ROLES, type Role } from '@canteras/shared';

export { ROLES };
export type { Role };

/**
 * Roles a partir del claim `cognito:groups`: llega como CADENA `"[owner staff]"` (API Gateway)
 * o como arreglo (token JWT). Separa SOLO por espacios y compara el nombre EXACTO.
 * Sirve únicamente para mostrar/ocultar: quien autoriza es el servidor.
 */
export function rolesFromClaim(raw: unknown): Role[] {
  return rolesFromGroups(parseGroupsClaim(raw));
}

/** Coincidencia exacta, sin jerarquía: la ruta enumera los roles permitidos. */
export function canAccess(
  userRoles: readonly Role[],
  allowed: readonly [Role, ...Role[]],
): boolean {
  return hasAnyRole(userRoles, allowed);
}

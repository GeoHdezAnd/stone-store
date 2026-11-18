import { isRole, type Role } from './roles';

/**
 * Interpreta el claim `cognito:groups`. En API Gateway HTTP API (payload v2) llega como
 * CADENA (`"[owner staff]"`), no como arreglo. Nunca se usa `includes` sobre la cadena:
 * `"[owner-solo-lectura]"` contiene `owner` y sería una escalada de privilegios.
 *
 * El claim serializado es AMBIGUO, así que no se valida el formato: se separa SOLO por
 * espacios en blanco (así serializa API Gateway los arreglos). Comas y comillas se quedan
 * DENTRO del nombre del grupo: `"[x,owner]"` es el grupo `x,owner` (sin rol), nunca `owner`.
 * Consecuencia (falla cerrado): `"[owner, staff]"` da `owner,` y `staff`.
 *
 * Requisitos de operación: los nombres de grupo de Cognito NO deben contener espacios, y la
 * Lambda de invitación solo debe asignar valores de `ROLES`. Mayúsculas/minúsculas exactas.
 * No lanza excepciones.
 */
export function parseGroupsClaim(raw: unknown): string[] {
  let items: unknown[];
  if (typeof raw === 'string') {
    let s = raw.trim();
    if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
    items = s.split(/\s+/);
  } else if (Array.isArray(raw)) {
    items = raw;
  } else {
    return [];
  }
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const name = item.trim();
    if (name !== '' && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Solo los grupos que son exactamente un rol conocido; el resto se ignora. */
export function rolesFromGroups(groups: readonly string[]): Role[] {
  const out: Role[] = [];
  for (const g of groups) {
    if (isRole(g) && !out.includes(g)) out.push(g);
  }
  return out;
}

/**
 * Coincidencia exacta, SIN jerarquía: cada ruta enumera los roles permitidos.
 * Si `allowed` viene vacío (no debería) falla cerrado.
 */
export function hasAnyRole(
  userRoles: readonly Role[],
  allowed: readonly [Role, ...Role[]],
): boolean {
  return allowed.some((r) => userRoles.includes(r));
}

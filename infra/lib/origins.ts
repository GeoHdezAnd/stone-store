import { type DeployEnv } from './config.js';

export const DEFAULT_DEV_ORIGINS = ['http://localhost:5173'];

/** Origen por defecto del sitio público en dev (servidor de Astro). Solo aplica si no hay SITE_ORIGINS. */
export const DEFAULT_DEV_SITE_ORIGINS = ['http://localhost:4321'];

/**
 * Comprueba cada origen: nunca `*`, debe ser EXACTAMENTE un origen canónico y, en prod, `https` sin
 * localhost, loopback ni 0.0.0.0. No exige que la lista sea no vacía.
 */
function checkOrigins(deploy: Pick<DeployEnv, 'name'>, list: readonly string[]): void {
  for (const o of list) {
    if (o.includes('*')) {
      throw new Error(`Origen CORS inválido "${o}": no se permite el comodín *.`);
    }
    // Debe ser EXACTAMENTE un origen canónico (esquema + host + puerto no estándar): rechaza
    // `null`, `file://`, rutas, credenciales (`https://a@evil.com`), mayúsculas y puertos por defecto.
    let canonical: string;
    let host: string;
    try {
      const url = new URL(o);
      canonical = url.origin;
      host = url.hostname;
    } catch {
      throw new Error(`Origen CORS inválido "${o}": no es una URL.`);
    }
    if (canonical !== o) {
      throw new Error(
        `Origen CORS inválido "${o}": debe ser un origen canónico (${canonical === 'null' ? 'https://host' : canonical}).`,
      );
    }
    if (host.endsWith('.')) {
      throw new Error(`Origen CORS inválido "${o}": el host no puede terminar en punto final.`);
    }
  }
  if (deploy.name === 'prod') {
    // LIMITACIÓN: `https://admin.ejemplo.mx.evil.com` es sintácticamente válido y no se puede
    // distinguir de un dominio legítimo; acertar el origen es responsabilidad de quien despliega.
    for (const o of list) {
      if (!o.startsWith('https://')) {
        throw new Error(`Origen CORS inválido en prod "${o}": debe ser https://host.`);
      }
      const host = new URL(o).hostname;
      if (host === 'localhost' || host === '[::1]' || host === '0.0.0.0' || /^127\./.test(host)) {
        throw new Error(
          `Origen CORS inválido en prod "${o}": no se permite localhost, loopback ni 0.0.0.0.`,
        );
      }
    }
  }
}

/**
 * Valida los orígenes CORS del dashboard. Nunca `*`. En prod son obligatorios y deben ser orígenes
 * `https://host[:puerto]` (sin ruta) que no sean localhost ni 127.0.0.1.
 */
export function validateAllowedOrigins(
  deploy: Pick<DeployEnv, 'name'>,
  origins: readonly string[] | undefined,
): string[] {
  const list = [...(origins ?? (deploy.name === 'dev' ? DEFAULT_DEV_ORIGINS : []))];
  checkOrigins(deploy, list);
  if (deploy.name === 'prod' && list.length === 0) {
    throw new Error(
      'prod requiere orígenes CORS explícitos (allowedOrigins / variable ADMIN_ORIGINS).',
    );
  }
  return list;
}

/**
 * Valida los orígenes CORS del SITIO PÚBLICO (variable SITE_ORIGINS), que se unen a los del dashboard
 * solo en la API (el bucket de media no los recibe). Mismas reglas que el dashboard. A diferencia de
 * aquellos, pueden faltar en prod: la API se puede desplegar antes de que exista el dominio del sitio.
 * En dev, sin valor, se usa el servidor local de Astro.
 */
export function validateSiteOrigins(
  deploy: Pick<DeployEnv, 'name'>,
  origins: readonly string[] | undefined,
): string[] {
  const list = [...(origins ?? (deploy.name === 'dev' ? DEFAULT_DEV_SITE_ORIGINS : []))];
  checkOrigins(deploy, list);
  return list;
}

/** Une listas de orígenes sin duplicados, conservando el orden de aparición. */
export function mergeOrigins(...lists: readonly (readonly string[])[]): string[] {
  return [...new Set(lists.flat())];
}

import { z } from 'zod';

const httpUrl = z.string().refine((v) => {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}, 'Debe ser una URL http(s) válida');

const schema = z.strictObject({
  apiUrl: httpUrl,
  userPoolId: z.string().min(1),
  userPoolClientId: z.string().min(1),
  region: z.string().min(1),
  cognitoEndpoint: z.string().min(1).optional(),
});

export interface AppConfig {
  /** Sin barra final. */
  apiUrl: string;
  userPoolId: string;
  userPoolClientId: string;
  region: string;
  /** URL absoluta (un valor relativo como `/cognito/` se resuelve contra el origen actual). */
  cognitoEndpoint?: string;
}

/** Valida el contenido de `config.json` y normaliza `apiUrl` y `cognitoEndpoint`. */
export function parseConfig(raw: unknown): AppConfig {
  const c = schema.parse(raw);
  const out: AppConfig = {
    apiUrl: c.apiUrl.replace(/\/+$/, ''),
    userPoolId: c.userPoolId,
    userPoolClientId: c.userPoolClientId,
    region: c.region,
  };
  if (c.cognitoEndpoint !== undefined) {
    const endpoint = new URL(c.cognitoEndpoint, location.origin);
    if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
      throw new Error('cognitoEndpoint debe ser http(s)');
    }
    out.cognitoEndpoint = endpoint.toString();
  }
  return out;
}

/**
 * Lee `/config.json` en tiempo de ejecución (nada de un entorno se compila en el bundle).
 * Cualquier fallo se reporta con un mensaje que menciona `config.json`.
 */
export async function loadConfig(): Promise<AppConfig> {
  let res: Response;
  try {
    res = await fetch('/config.json', { cache: 'no-store' });
  } catch {
    throw new Error('No se pudo leer config.json (¿hay conexión con el servidor?).');
  }
  if (!res.ok) {
    throw new Error(`No se pudo leer config.json (HTTP ${res.status}).`);
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Error('config.json no contiene JSON válido.');
  }
  try {
    return parseConfig(json);
  } catch {
    throw new Error('config.json tiene un formato inválido: revisa los campos requeridos.');
  }
}

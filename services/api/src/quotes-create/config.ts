export interface QuotesCreateConfig {
  quotes: string;
  counters: string;
  stones: string;
  freightConfig: string;
  settings: string;
  /** Origen del dashboard para el enlace del aviso al dueño. Sin él, el aviso va sin enlace. */
  adminBaseUrl?: string;
  /** Solo `fake` (emulador): acepta el token literal `test-pass`. Infra lo pone ÚNICAMENTE con emulador. */
  turnstileMode?: 'fake';
  /** Nombre del parámetro SSM (SecureString) con el secreto de Turnstile. */
  turnstileSecretParam?: string;
  /** Hostnames de nuestro sitio (de SITE_ORIGINS) que se exigen en la respuesta de Turnstile. */
  turnstileAllowedHostnames?: string[];
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new Error(`Falta la variable de entorno ${name}.`);
  }
  return value;
}

function optional(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
}

// Nombre jerárquico de SSM: `/a/b-c_d.e`, sin comodines, sin `//` ni barra final, máx. 1011 caracteres.
export const SSM_PARAM_NAME_RE = /^\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
export const SSM_PARAM_NAME_MAX = 1011;

function parseAdminBaseUrl(raw: string): string {
  const fail = (): never => {
    throw new Error(
      'ADMIN_BASE_URL no es válida: debe ser un origen https (o http solo con localhost), sin ruta.',
    );
  };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail();
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  const schemeOk = url.protocol === 'https:' || (url.protocol === 'http:' && local);
  // Solo el origen: sin ruta, credenciales, query ni fragmento.
  // Hostname solo con letras, números, puntos y guiones: nada que pueda romper un atributo HTML.
  if (!schemeOk || !/^[a-z0-9.-]+$/i.test(url.hostname) || url.origin !== raw.replace(/\/+$/, '')) {
    fail();
  }
  return url.origin;
}

/** Lee las variables de entorno; si falta una obligatoria o una opcional es inválida, lanza un error claro. */
export function loadConfig(env: Record<string, string | undefined>): QuotesCreateConfig {
  const config: QuotesCreateConfig = {
    quotes: required(env, 'QUOTES_TABLE'),
    counters: required(env, 'COUNTERS_TABLE'),
    stones: required(env, 'STONES_TABLE'),
    freightConfig: required(env, 'FREIGHT_CONFIG_TABLE'),
    settings: required(env, 'SETTINGS_TABLE'),
  };

  const adminBaseUrl = optional(env, 'ADMIN_BASE_URL');
  if (adminBaseUrl !== undefined) config.adminBaseUrl = parseAdminBaseUrl(adminBaseUrl);

  const mode = optional(env, 'TURNSTILE_MODE');
  if (mode !== undefined) {
    if (mode !== 'fake') {
      throw new Error('TURNSTILE_MODE no es válido: el único valor permitido es "fake".');
    }
    config.turnstileMode = 'fake';
  }

  const param = optional(env, 'TURNSTILE_SECRET_PARAM');
  if (param !== undefined) {
    if (param.length > SSM_PARAM_NAME_MAX || !SSM_PARAM_NAME_RE.test(param)) {
      throw new Error(
        'TURNSTILE_SECRET_PARAM no es un nombre de parámetro SSM válido (/ruta/nombre).',
      );
    }
    config.turnstileSecretParam = param;
  }

  const hostnames = optional(env, 'TURNSTILE_ALLOWED_HOSTNAMES')
    ?.trim()
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== '');
  if (hostnames !== undefined && hostnames.length > 0) {
    // Solo el hostname: sin esquema, ruta, comodines, espacios, puntos dobles ni punto final.
    if (!hostnames.every((h) => /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(h))) {
      throw new Error(
        'TURNSTILE_ALLOWED_HOSTNAMES no es válida: lista de hostnames separados por comas (sin esquema ni ruta).',
      );
    }
    config.turnstileAllowedHostnames = hostnames;
  }

  if (config.turnstileMode !== undefined && config.turnstileSecretParam !== undefined) {
    throw new Error(
      'TURNSTILE_MODE=fake y TURNSTILE_SECRET_PARAM no pueden usarse a la vez (el modo falso es solo para el emulador).',
    );
  }
  return config;
}

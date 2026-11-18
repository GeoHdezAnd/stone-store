/**
 * Lógica pura de los scripts de desarrollo (dev-users.ts y dev-token.ts): validación de
 * argumentos y de entorno. Sin AWS, para poder probarla con tests unitarios.
 */
import { isRole, ROLES, type Role } from '@canteras/shared';

// IP fija de Floci. Replica FLOCI_IP de infra/lib/config.ts (scripts no importa infra);
// un test verifica que coinciden.
export const FLOCI_IP = '172.30.0.10';

const LOCAL_HOSTS: readonly string[] = ['localhost', '127.0.0.1', FLOCI_IP];

/**
 * Solo emulador. Valida que AWS_ENDPOINT_URL apunte a `localhost`, `127.0.0.1` o la IP de Floci
 * (hostname EXACTO, `http(s)`) y que las llaves sean las ficticias `test`. Devuelve el endpoint
 * para pasarlo EXPLÍCITO a cada cliente del SDK: así variables como
 * AWS_IGNORE_CONFIGURED_ENDPOINT_URLS, un `endpoint_url` de perfil o AWS_ENDPOINT_URL_<SERVICIO>
 * no pueden redirigir las llamadas a AWS real.
 */
export function emulatorEndpoint(env: NodeJS.ProcessEnv): string {
  const raw = env['AWS_ENDPOINT_URL'];
  if (!raw) {
    throw new Error(
      'Este script es SOLO para el emulador (Floci): define AWS_ENDPOINT_URL (y las variables de Floci de CLAUDE.md 9.2). En AWS real los usuarios se crean con la invitación del dashboard o desde la consola de Cognito.',
    );
  }
  if (env['APP_ENV'] === 'prod') {
    throw new Error('APP_ENV=prod no es compatible con los scripts de desarrollo.');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`AWS_ENDPOINT_URL inválido: "${raw}" no es una URL (endpoint de emulador).`);
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    !LOCAL_HOSTS.includes(url.hostname)
  ) {
    throw new Error(
      `AWS_ENDPOINT_URL "${raw}" no es un endpoint de emulador: el host debe ser exactamente ${LOCAL_HOSTS.join(', ')}.`,
    );
  }
  if (env['AWS_ACCESS_KEY_ID'] !== 'test') {
    throw new Error(
      'Con el emulador AWS_ACCESS_KEY_ID debe ser exactamente "test" (nunca llaves reales).',
    );
  }
  return raw;
}

export function assertEmulator(env: NodeJS.ProcessEnv): void {
  emulatorEndpoint(env);
}

export function parseRole(raw: string | undefined): Role {
  if (!isRole(raw)) {
    throw new Error(`Rol inválido: "${raw ?? ''}". Usa uno de: ${ROLES.join('|')}.`);
  }
  return raw;
}

export function validateEmail(raw: string | undefined): string {
  const email = raw?.trim().toLowerCase();
  if (email === undefined || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(`Correo inválido: "${raw ?? ''}".`);
  }
  // El pool no distingue mayúsculas (signInCaseSensitive:false); se normaliza igual.
  return email;
}

/**
 * La contraseña viene SOLO de la variable DEV_PASSWORD (nunca de argumentos, para que no quede
 * en el historial del shell ni en `ps`). Los mensajes de error nunca la incluyen.
 */
export function validatePassword(raw: string | undefined): string {
  if (!raw) {
    throw new Error('Falta la variable DEV_PASSWORD con la contraseña de prueba.');
  }
  const ok =
    raw.length >= 12 &&
    /[A-Z]/.test(raw) &&
    /[a-z]/.test(raw) &&
    /[0-9]/.test(raw) &&
    /[^A-Za-z0-9]/.test(raw);
  if (!ok) {
    throw new Error(
      'DEV_PASSWORD no cumple la política: mínimo 12 caracteres con mayúscula, minúscula, número y símbolo.',
    );
  }
  return raw;
}

const USERS_USAGE = 'Uso: npx tsx scripts/dev-users.ts <correo> <owner|staff>  (con DEV_PASSWORD)';
const TOKEN_USAGE = 'Uso: npx tsx scripts/dev-token.ts <correo>  (con DEV_PASSWORD)';

export function parseUsersArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): { email: string; role: Role; password: string } {
  assertEmulator(env);
  if (argv.length !== 2) throw new Error(USERS_USAGE);
  return {
    email: validateEmail(argv[0]),
    role: parseRole(argv[1]),
    password: validatePassword(env['DEV_PASSWORD']),
  };
}

export function parseTokenArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): { email: string; password: string } {
  assertEmulator(env);
  if (argv.length !== 1) throw new Error(TOKEN_USAGE);
  return {
    email: validateEmail(argv[0]),
    password: validatePassword(env['DEV_PASSWORD']),
  };
}

/** Salidas del AuthStack (ids fijos en infra/lib/auth-stack.ts). */
export function pickAuthOutputs(
  outputs: Record<string, string>,
  stackName: string,
): { userPoolId: string; clientId: string } {
  const userPoolId = outputs['UserPoolId'];
  const clientId = outputs['UserPoolClientId'];
  if (!userPoolId || !clientId) {
    throw new Error(
      `El stack ${stackName} no tiene las salidas "UserPoolId" y "UserPoolClientId". ¿Se desplegó?`,
    );
  }
  return { userPoolId, clientId };
}

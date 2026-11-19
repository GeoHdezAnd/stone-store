/**
 * Lógica pura de `admin-config.ts`: arma y valida el `config.json` del dashboard a partir de
 * las salidas de los stacks. Sin AWS ni I/O, para probarla con tests unitarios.
 *
 * El dashboard (`apps/admin/src/config.ts`) valida el mismo archivo al arrancar. Como `scripts`
 * no puede importar código del frontend (CLAUDE.md 9.1), el schema se duplica aquí y un test
 * (`admin-config-lib.test.ts`) verifica que ambos tengan las mismas claves.
 */
import { z } from 'zod';

import { emulatorEndpoint } from './dev-lib';

/** Origen del servidor de Vite (`npm run dev`), que hace proxy a Floci. Ver apps/admin/vite.config.ts. */
export const VITE_DEV_ORIGIN = 'http://localhost:5173';

const LOCAL_HOSTS: readonly string[] = ['localhost', '127.0.0.1'];

function isValidApiUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  // http solo contra localhost (desarrollo); en cualquier otro host se exige https.
  return url.protocol === 'http:' && LOCAL_HOSTS.includes(url.hostname);
}

export const adminConfigSchema = z.strictObject({
  apiUrl: z
    .string()
    .refine(isValidApiUrl, 'apiUrl debe ser https (http solo en localhost o 127.0.0.1)'),
  userPoolId: z.string().min(1),
  userPoolClientId: z.string().min(1),
  region: z.string().min(1),
  cognitoEndpoint: z.string().min(1).optional(),
});

export type AdminConfig = z.infer<typeof adminConfigSchema>;

export function validateAdminConfig(raw: unknown): AdminConfig {
  const result = adminConfigSchema.safeParse(raw);
  if (!result.success) {
    const detalle = result.error.issues
      .map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`)
      .join('; ');
    throw new Error(`El config.json generado no es válido (${detalle}).`);
  }
  return result.data;
}

export interface AdminConfigInput {
  readonly region: string;
  /** `true` con Floci: usa la ruta local por el proxy de Vite. */
  readonly emulated: boolean;
  /** Salidas de `canteras-auth-<env>`. */
  readonly authOutputs: Record<string, string>;
  /** Salidas de `canteras-api-<env>`. */
  readonly apiOutputs: Record<string, string>;
  readonly authStack: string;
  readonly apiStack: string;
}

function need(outputs: Record<string, string>, key: string, stack: string): string {
  const value = outputs[key];
  if (!value) throw new Error(`El stack ${stack} no tiene la salida "${key}". ¿Se desplegó?`);
  return value;
}

/**
 * Floci: la salida `ApiUrl` no sirve (el emulador responde el preflight CORS con 401), así que
 * se usa la ruta local `/_aws/execute-api/<HttpApiId>/$default` pasando por el servidor de Vite,
 * y Cognito por `/cognito/` (Floci no responde CORS en Cognito). AWS real: `ApiUrl` sin barra
 * final y sin `cognitoEndpoint`.
 */
export function buildAdminConfig(input: AdminConfigInput): AdminConfig {
  const userPoolId = need(input.authOutputs, 'UserPoolId', input.authStack);
  const userPoolClientId = need(input.authOutputs, 'UserPoolClientId', input.authStack);

  if (input.emulated) {
    const apiId = need(input.apiOutputs, 'HttpApiId', input.apiStack);
    return validateAdminConfig({
      apiUrl: `${VITE_DEV_ORIGIN}/_aws/execute-api/${apiId}/$default`,
      userPoolId,
      userPoolClientId,
      region: input.region,
      cognitoEndpoint: '/cognito/',
    });
  }
  const apiUrl = need(input.apiOutputs, 'ApiUrl', input.apiStack).replace(/\/+$/, '');
  return validateAdminConfig({
    apiUrl,
    userPoolId,
    userPoolClientId,
    region: input.region,
  });
}

export function serializeAdminConfig(config: AdminConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export interface AdminConfigArgs {
  readonly appEnv: 'dev' | 'prod';
  readonly region: string;
  readonly emulated: boolean;
  /** Endpoint validado del emulador (solo si `emulated`). */
  readonly endpoint: string | undefined;
  /** Directorio donde se escribe `config.json`. */
  readonly outDir: string;
}

export const ADMIN_CONFIG_USAGE =
  'Uso: npx tsx scripts/admin-config.ts [--out <directorio>]  (por defecto apps/admin/public)';

export function parseAdminConfigArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): AdminConfigArgs {
  let outDir = 'apps/admin/public';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--') || value === '') {
        throw new Error(ADMIN_CONFIG_USAGE);
      }
      outDir = value;
      i += 1;
    } else {
      throw new Error(ADMIN_CONFIG_USAGE);
    }
  }

  const appEnv = env['APP_ENV'] ?? 'dev';
  if (appEnv !== 'dev' && appEnv !== 'prod') {
    throw new Error(`APP_ENV inválido: "${appEnv}". Usa "dev" o "prod".`);
  }
  const region = env['AWS_REGION'] ?? env['AWS_DEFAULT_REGION'] ?? 'us-east-1';
  const emulated = Boolean(env['AWS_ENDPOINT_URL']);
  if (appEnv === 'prod' && emulated) {
    throw new Error('APP_ENV=prod no puede usar AWS_ENDPOINT_URL (emulador).');
  }
  // Con emulador, valida host y llaves ficticias (misma salvaguarda que los scripts dev-*).
  const endpoint = emulated ? emulatorEndpoint(env) : undefined;
  return { appEnv, region, emulated, endpoint, outDir };
}

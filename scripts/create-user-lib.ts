/**
 * Lógica de `create-user.ts`: crea (o asegura) el usuario REAL del dashboard en el Cognito de
 * AWS real. Los clientes de AWS y el prompt llegan INYECTADOS (`CreateUserDeps`), así que todo
 * se prueba con tests unitarios sin red ni credenciales.
 *
 * Reglas de seguridad:
 * - Solo AWS real: con cualquier `AWS_ENDPOINT_URL*` definida (emulador) aborta; para Floci
 *   existe `dev-users.ts`.
 * - La cuenta de AWS se verifica con STS contra `EXPECTED_AWS_ACCOUNT`; los mensajes nunca
 *   imprimen ningún ID de cuenta.
 * - La contraseña NUNCA va por argumentos y NUNCA se imprime (ni en errores ni en el resumen).
 * - Un usuario existente solo se «asegura» si está CONFIRMED y habilitado, y nunca cambia de
 *   rol desde aquí.
 */
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  AdminSetUserPasswordCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { isRole, ROLES, type Role } from '@canteras/shared';

/** Error con un mensaje seguro de mostrar tal cual (nunca contiene secretos ni IDs). */
export class CreateUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CreateUserError';
  }
}

export type CognitoCommand =
  | AdminGetUserCommand
  | AdminListGroupsForUserCommand
  | AdminCreateUserCommand
  | AdminSetUserPasswordCommand
  | AdminAddUserToGroupCommand;

export interface CreateUserDeps {
  readonly env: NodeJS.ProcessEnv;
  /**
   * Contraseña ya sacada del entorno por la cáscara (`takePasswordFromEnv`). Se inyecta para
   * que no se quede en `process.env`, donde la heredaría cualquier proceso hijo del SDK.
   */
  readonly password: string | undefined;
  /** `true` si hay terminal interactiva (permite pedir la contraseña sin eco). */
  readonly isTTY: boolean;
  /** Pide un texto SIN eco en la terminal. */
  readonly promptHidden: (label: string) => Promise<string>;
  /** Cuenta real según STS `GetCallerIdentity`. */
  readonly getAccountId: () => Promise<string | undefined>;
  /** Salidas del stack de CloudFormation. */
  readonly getStackOutputs: (stackName: string) => Promise<Record<string, string>>;
  /** Cliente de Cognito para la región del user pool. */
  readonly cognitoFor: (region: string) => { send: (command: CognitoCommand) => Promise<unknown> };
}

export interface CreateUserArgs {
  readonly email: string;
  readonly role: Role;
  readonly resetPassword: boolean;
}

const USAGE =
  'Uso: npx tsx scripts/create-user.ts <correo> [owner|staff] [--reset-password]  (la contraseña va en NEW_USER_PASSWORD o se pide sin eco)';
const EMAIL_MAX = 254;
const POOL_ID_RE = /^[a-z]{2}-[a-z]+-[0-9]_[A-Za-z0-9]+$/;
const EMAIL_FORBIDDEN = new Set(['<', '>', '"', "'", '\\']);
/** Cuenta ficticia del emulador (igual que infra/lib/config.ts). */
const EMULATOR_ACCOUNT = '000000000000';
const MAX_GROUP_PAGES = 10;

/** ASCII imprimible (0x21-0x7e) sin comillas, ángulos ni barra invertida. */
function isSafeAsciiChar(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code >= 0x21 && code <= 0x7e && !EMAIL_FORBIDDEN.has(ch);
}

/**
 * Solo ASCII imprimible: se rechazan a propósito los correos internacionalizados (homoglifos
 * como «ａ», caracteres invisibles de ancho cero, etc.) para que el usuario creado sea
 * exactamente el que el dueño escribió. Este script no soporta IDN/EAI.
 */
export function validateUserEmail(raw: string | undefined): string {
  const bad = new CreateUserError(
    'Correo inválido: usa solo ASCII imprimible con el formato usuario@dominio.tld.',
  );
  if (raw === undefined || raw.length === 0 || raw.length > EMAIL_MAX) throw bad;
  for (const ch of raw) if (!isSafeAsciiChar(ch)) throw bad;
  if (!/^[^@]+@[^@]+\.[^@]+$/.test(raw)) throw bad;
  // El pool no distingue mayúsculas (signInCaseSensitive:false en auth-stack.ts).
  return raw.toLowerCase();
}

export function validateUserPoolId(raw: string | undefined): string {
  if (raw === undefined || !POOL_ID_RE.test(raw)) {
    throw new CreateUserError(
      'El id del user pool no tiene el formato esperado (p. ej. us-east-1_AbC123xyz).',
    );
  }
  return raw;
}

/**
 * Símbolos que Cognito cuenta como caracteres especiales, tal cual la doc oficial
 * (https://docs.aws.amazon.com/cognito/latest/developerguide/managing-users-passwords.html):
 * ^ $ * . [ ] { } ( ) ? " ! @ # % & / \ , > < ' : ; | _ ~ ` = + -
 * La misma página dice que, además, se permiten espacios que no sean iniciales ni finales
 * (no cuentan como símbolo) y que el máximo es de 256 caracteres. Para no depender de qué hace
 * Cognito con otros caracteres (ñ, €, emojis, NBSP), el script solo acepta letras latinas
 * básicas, números, estos símbolos y espacios intermedios.
 */
const COGNITO_SYMBOLS = new Set('^$*.[]{}()?"!@#%&/\\,><\':;|_~`=+-');
const PASSWORD_MAX = 256;

function isAllowedPasswordChar(ch: string): boolean {
  return /^[A-Za-z0-9 ]$/.test(ch) || COGNITO_SYMBOLS.has(ch);
}

/**
 * Replica la política de `infra/lib/auth-stack.ts` (mínimo 12 con mayúscula, minúscula, número
 * y símbolo) con el juego de caracteres real de Cognito. Los mensajes dicen QUÉ regla falla,
 * nunca la contraseña.
 */
export function validateNewPassword(raw: string): string {
  const chars = Array.from(raw);
  if (chars.length > PASSWORD_MAX) {
    throw new CreateUserError(`La contraseña no puede pasar de ${PASSWORD_MAX} caracteres.`);
  }
  if (raw.startsWith(' ') || raw.endsWith(' ')) {
    throw new CreateUserError('La contraseña no puede empezar ni terminar con espacio.');
  }
  if (!chars.every(isAllowedPasswordChar)) {
    throw new CreateUserError(
      'La contraseña tiene caracteres no permitidos: usa solo letras latinas sin acentos, números, los símbolos que acepta Cognito y espacios intermedios.',
    );
  }
  const missing: string[] = [];
  if (chars.length < 12) missing.push('tener al menos 12 caracteres');
  if (!/[A-Z]/.test(raw)) missing.push('incluir una mayúscula');
  if (!/[a-z]/.test(raw)) missing.push('incluir una minúscula');
  if (!/[0-9]/.test(raw)) missing.push('incluir un número');
  if (!chars.some((ch) => COGNITO_SYMBOLS.has(ch))) missing.push('incluir un símbolo');
  if (missing.length > 0) {
    throw new CreateUserError(`La contraseña no cumple la política: debe ${missing.join(', ')}.`);
  }
  return raw;
}

/**
 * Saca la contraseña de `NEW_USER_PASSWORD` y la BORRA del entorno. La cáscara lo llama antes
 * de crear cualquier cliente del SDK: un `credential_process` heredaría el entorno completo.
 */
export function takePasswordFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const value = env['NEW_USER_PASSWORD'];
  delete env['NEW_USER_PASSWORD'];
  return value ? value : undefined;
}

export type PromptStatus = 'continue' | 'done' | 'cancel' | 'invalid';

/**
 * Procesa un bloque de teclas del prompt sin eco (lógica pura; la cáscara solo lee stdin).
 * Ignora Ctrl+Z, ESC y las secuencias de flechas/teclas especiales; el retroceso borra un
 * carácter completo (también emojis); un pegado con texto DESPUÉS del salto de línea es
 * «Entrada inválida» (no se descarta en silencio).
 */
export function processPromptChunk(
  buffer: readonly string[],
  chunk: string,
): { buffer: string[]; status: PromptStatus } {
  const out = [...buffer];
  const chars = Array.from(chunk);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] ?? '';
    if (ch === '\r' || ch === '\n' || ch === '\u0004') {
      let rest = chars.slice(i + 1);
      if (ch === '\r' && rest[0] === '\n') rest = rest.slice(1);
      return { buffer: out, status: rest.length > 0 ? 'invalid' : 'done' };
    }
    if (ch === '\u0003') return { buffer: out, status: 'cancel' };
    if (ch === '\u001b') {
      // CSI (ESC [ ...) o SS3 (ESC O x): se consume hasta el byte final de la secuencia.
      const next = chars[i + 1];
      if (next === '[' || next === 'O') {
        i += 1;
        while (i + 1 < chars.length) {
          i += 1;
          const code = (chars[i] ?? '').charCodeAt(0);
          if (code >= 0x40 && code <= 0x7e) break;
        }
      }
      continue;
    }
    if (ch === '\u007f' || ch === '\b') {
      out.pop();
      continue;
    }
    if ((ch.codePointAt(0) ?? 0) < 0x20) continue;
    out.push(ch);
  }
  return { buffer: out, status: 'continue' };
}

export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

export function parseCreateUserArgs(argv: readonly string[]): CreateUserArgs {
  const positional: string[] = [];
  let resetPassword = false;
  for (const arg of argv) {
    if (arg === '--password' || arg.startsWith('--password=')) {
      throw new CreateUserError(
        'La contraseña no se acepta por argumentos (queda en el historial y en `ps`). Usa la variable NEW_USER_PASSWORD o el prompt sin eco.',
      );
    }
    if (arg === '--reset-password') resetPassword = true;
    else if (arg.startsWith('--')) throw new CreateUserError(`Bandera desconocida. ${USAGE}`);
    else positional.push(arg);
  }
  if (positional.length < 1 || positional.length > 2) throw new CreateUserError(USAGE);
  const roleRaw = positional[1] ?? 'owner';
  if (!isRole(roleRaw)) {
    throw new CreateUserError(`Rol inválido. Usa uno de: ${ROLES.join('|')}.`);
  }
  return { email: validateUserEmail(positional[0]), role: roleRaw, resetPassword };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : '';
}

/** Traduce un error de AWS a un mensaje seguro: nunca usa `error.message`. */
function awsErrorMessage(error: unknown): string {
  switch (errorName(error)) {
    case 'UsernameExistsException':
      return 'El usuario ya existe (se creó en paralelo). Vuelve a ejecutar el script.';
    case 'InvalidPasswordException':
      return 'Cognito rechazó la contraseña por la política del user pool.';
    case 'NotAuthorizedException':
      return 'Sin permisos en AWS para esta operación: revisa las credenciales y el rol de IAM.';
    case 'ResourceNotFoundException':
      return 'No se encontró el user pool o el grupo: ¿se desplegó canteras-auth-<env>?';
    case 'LimitExceededException':
    case 'TooManyRequestsException':
      return 'Demasiadas solicitudes a Cognito (límite excedido): espera un momento y reintenta.';
    default:
      return 'Error inesperado al hablar con AWS. Revisa credenciales, región y permisos.';
  }
}

async function resolvePassword(deps: CreateUserDeps): Promise<string> {
  if (deps.password) return validateNewPassword(deps.password);
  if (!deps.isTTY) {
    throw new CreateUserError(
      'Falta la contraseña: define NEW_USER_PASSWORD o ejecuta el script en una terminal interactiva.',
    );
  }
  const first = await deps.promptHidden('Contraseña nueva: ');
  validateNewPassword(first);
  const second = await deps.promptHidden('Repite la contraseña: ');
  if (first !== second) throw new CreateUserError('Las contraseñas no coinciden.');
  return first;
}

async function accountGuard(deps: CreateUserDeps, expected: string): Promise<void> {
  let actual: string | undefined;
  try {
    actual = await deps.getAccountId();
  } catch {
    throw new CreateUserError(
      'No se pudo consultar la cuenta de AWS con STS: revisa las credenciales.',
    );
  }
  if (actual === undefined || actual.length === 0) {
    throw new CreateUserError('STS no devolvió la cuenta de AWS: revisa las credenciales.');
  }
  if (actual !== expected) {
    throw new CreateUserError(
      'La cuenta de AWS de las credenciales no coincide con EXPECTED_AWS_ACCOUNT. Abortado.',
    );
  }
}

async function resolvePoolId(deps: CreateUserDeps, appEnv: string): Promise<string> {
  const fromEnv = deps.env['USER_POOL_ID'];
  if (fromEnv) return validateUserPoolId(fromEnv);
  const stackName = `canteras-auth-${appEnv}`;
  let outputs: Record<string, string>;
  try {
    outputs = await deps.getStackOutputs(stackName);
  } catch {
    throw new CreateUserError(
      `No se pudo leer el stack ${stackName} en CloudFormation. Define USER_POOL_ID para saltarlo.`,
    );
  }
  const id = outputs['UserPoolId'];
  if (!id) throw new CreateUserError(`El stack ${stackName} no tiene la salida "UserPoolId".`);
  return validateUserPoolId(id);
}

interface ExistingUser {
  readonly UserStatus?: string;
  readonly Enabled?: boolean;
}

/** Falla (sin escribir) si el usuario existente no está listo; `--reset-password` lo permite. */
function assertUserReady(user: ExistingUser, resetPassword: boolean): void {
  if (user.Enabled === false) {
    throw new CreateUserError(
      'El usuario está deshabilitado; habilítalo en la consola o con AdminEnableUser antes de continuar.',
    );
  }
  if (user.UserStatus !== 'CONFIRMED' && !resetPassword) {
    throw new CreateUserError(
      `El usuario existe pero no está listo (estado: ${user.UserStatus || 'desconocido'}). Vuelve a correr con --reset-password para fijar una contraseña permanente.`,
    );
  }
}

/** Aborta si el usuario existente ya está en un grupo distinto del pedido (sin escalar roles). */
async function assertNoOtherGroup(
  cognito: ReturnType<CreateUserDeps['cognitoFor']>,
  poolId: string,
  email: string,
  role: Role,
): Promise<void> {
  let nextToken: string | undefined;
  for (let page = 0; page < MAX_GROUP_PAGES; page++) {
    let out: { Groups?: { GroupName?: string }[]; NextToken?: string };
    try {
      out = (await cognito.send(
        new AdminListGroupsForUserCommand({
          UserPoolId: poolId,
          Username: email,
          ...(nextToken === undefined ? {} : { NextToken: nextToken }),
        }),
      )) as typeof out;
    } catch (error) {
      throw new CreateUserError(awsErrorMessage(error));
    }
    for (const group of out.Groups ?? []) {
      if (group.GroupName !== undefined && group.GroupName !== role) {
        throw new CreateUserError(
          `El usuario ya pertenece al grupo ${group.GroupName}; no se cambia de rol desde este script. Quítalo del grupo en la consola si de verdad quieres cambiarlo.`,
        );
      }
    }
    nextToken = out.NextToken;
    if (nextToken === undefined) return;
  }
  throw new CreateUserError(
    'El usuario tiene demasiadas páginas de grupos; revísalo en la consola.',
  );
}

/** Ejecuta el flujo completo y devuelve las líneas del resumen. Lanza `CreateUserError`. */
export async function runCreateUser(
  argv: readonly string[],
  deps: CreateUserDeps,
): Promise<string[]> {
  const { env } = deps;
  // Cualquier AWS_ENDPOINT_URL* DEFINIDA (aunque vacía) redirigiría el SDK: no se imprime su valor.
  if (
    Object.keys(env).some((key) => key.startsWith('AWS_ENDPOINT_URL') && env[key] !== undefined)
  ) {
    throw new CreateUserError(
      'Este script es SOLO para AWS real y detectó una variable AWS_ENDPOINT_URL* (emulador). Para Floci usa scripts/dev-users.ts.',
    );
  }
  const appEnv = env['APP_ENV'] ?? 'dev';
  if (appEnv !== 'dev' && appEnv !== 'prod') {
    throw new CreateUserError('APP_ENV solo acepta "dev" o "prod".');
  }
  const expected = env['EXPECTED_AWS_ACCOUNT'];
  if (!expected) {
    throw new CreateUserError(
      'Define EXPECTED_AWS_ACCOUNT (12 dígitos): evita crear el usuario en la cuenta equivocada.',
    );
  }
  if (!/^\d{12}$/.test(expected)) {
    throw new CreateUserError('EXPECTED_AWS_ACCOUNT debe tener exactamente 12 dígitos.');
  }
  if (expected === EMULATOR_ACCOUNT) {
    throw new CreateUserError(
      'EXPECTED_AWS_ACCOUNT es la cuenta del emulador: este script es solo para AWS real (para Floci usa scripts/dev-users.ts).',
    );
  }
  if (appEnv === 'prod' && env['CREATE_USER_CONFIRM'] !== 'si') {
    throw new CreateUserError(
      'Para crear usuarios en prod define CREATE_USER_CONFIRM=si. Abortado.',
    );
  }

  const { email, role, resetPassword } = parseCreateUserArgs(argv);
  await accountGuard(deps, expected);
  const poolId = await resolvePoolId(deps, appEnv);
  const cognito = deps.cognitoFor(poolId.split('_')[0] ?? '');

  let existing: ExistingUser | undefined;
  try {
    existing = (await cognito.send(
      new AdminGetUserCommand({ UserPoolId: poolId, Username: email }),
    )) as ExistingUser;
  } catch (error) {
    if (errorName(error) !== 'UserNotFoundException') {
      throw new CreateUserError(awsErrorMessage(error));
    }
  }
  const exists = existing !== undefined;

  if (existing === undefined) {
    if (resetPassword) {
      throw new CreateUserError(
        'El usuario no existe: --reset-password solo aplica a usuarios existentes. Ejecuta el script sin esa bandera para crearlo.',
      );
    }
  } else {
    assertUserReady(existing, resetPassword);
    await assertNoOtherGroup(cognito, poolId, email, role);
  }

  // La contraseña solo se necesita para un usuario nuevo o con --reset-password.
  const needsPassword = !exists || resetPassword;
  const password = needsPassword ? await resolvePassword(deps) : undefined;

  if (!exists) {
    try {
      await cognito.send(
        new AdminCreateUserCommand({
          UserPoolId: poolId,
          Username: email,
          UserAttributes: [
            { Name: 'email', Value: email },
            { Name: 'email_verified', Value: 'true' },
          ],
          // Sin correo de invitación: la contraseña la fija este script.
          MessageAction: 'SUPPRESS',
        }),
      );
    } catch (error) {
      throw new CreateUserError(awsErrorMessage(error));
    }
  }

  if (password !== undefined) {
    try {
      await cognito.send(
        new AdminSetUserPasswordCommand({
          UserPoolId: poolId,
          Username: email,
          Password: password,
          Permanent: true,
        }),
      );
    } catch (error) {
      const hint = exists
        ? ''
        : ' El usuario quedó creado con una contraseña temporal que Cognito generó y no envió a nadie: vuelve a ejecutar con --reset-password para fijar la contraseña permanente.';
      throw new CreateUserError(`${awsErrorMessage(error)}${hint}`);
    }
  }

  try {
    await cognito.send(
      new AdminAddUserToGroupCommand({ UserPoolId: poolId, Username: email, GroupName: role }),
    );
  } catch (error) {
    throw new CreateUserError(awsErrorMessage(error));
  }

  const lines = [
    `✔ Usuario ${maskEmail(email)} listo en el grupo ${role} (${exists ? 'ya existía' : 'creado'}).`,
  ];
  if (exists && resetPassword) lines.push('La contraseña se cambió.');
  lines.push(
    'En el primer inicio de sesión, el dashboard te pedirá configurar la app autenticadora (TOTP): el pool exige MFA.',
  );
  return lines;
}

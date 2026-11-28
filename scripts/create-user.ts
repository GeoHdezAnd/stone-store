/**
 * Crea (o asegura) el usuario REAL del dashboard (`owner` o `staff`) en el Cognito de AWS real.
 *
 * Uso (la contraseña NO va en la línea de comandos ni queda en el historial del shell):
 *   read -rs NEW_USER_PASSWORD; export NEW_USER_PASSWORD
 *   EXPECTED_AWS_ACCOUNT=<12 dígitos> npx tsx scripts/create-user.ts <correo> [owner|staff] [--reset-password]
 * Variables:
 *   EXPECTED_AWS_ACCOUNT  obligatoria: se compara con la cuenta real (STS) y aborta si no coincide.
 *   APP_ENV               dev (por defecto) o prod; prod exige CREATE_USER_CONFIRM=si.
 *   NEW_USER_PASSWORD     contraseña (12+ con mayúscula, minúscula, número y símbolo). Si falta y hay
 *                         terminal interactiva, se pide dos veces SIN eco.
 *   USER_POOL_ID          opcional: evita consultar CloudFormation (stack canteras-auth-<env>).
 *   AWS_PROFILE / credenciales de AWS reales (cadena estándar del SDK).
 *   AWS_REGION            región de STS y CloudFormation; por defecto us-east-1. Defínela si el
 *                         stack canteras-auth-<env> está en otra (Cognito usa la del user pool).
 * La contraseña se lee y se BORRA de process.env antes de crear cualquier cliente del SDK.
 *
 * IAM mínimo del perfil: sts:GetCallerIdentity, cloudformation:DescribeStacks (omitible con
 * USER_POOL_ID) y cognito-idp:AdminGetUser, AdminCreateUser, AdminSetUserPassword,
 * AdminListGroupsForUser, AdminAddUserToGroup sobre el user pool.
 *
 * Solo AWS real: con AWS_ENDPOINT_URL (Floci) aborta; para el emulador usa scripts/dev-users.ts.
 * Idempotente: si el usuario ya existe no toca su contraseña salvo con --reset-password.
 * No toca el MFA: el primer inicio de sesión pasa por el alta de TOTP en el dashboard.
 */
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';

import {
  CreateUserError,
  processPromptChunk,
  runCreateUser,
  takePasswordFromEnv,
  type CreateUserDeps,
} from './create-user-lib';

// ANTES de crear cualquier cliente del SDK: un `credential_process` heredaría el entorno.
const password = takePasswordFromEnv(process.env);

/** Lee una línea de la terminal sin mostrar lo que se teclea (modo crudo; solo con TTY). */
function promptHidden(label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(label);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buffer: string[] = [];
    const finish = (): void => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write('\n');
    };
    const onData = (chunk: string): void => {
      const result = processPromptChunk(buffer, chunk);
      buffer = result.buffer;
      if (result.status === 'continue') return;
      finish();
      if (result.status === 'done') resolve(buffer.join(''));
      else if (result.status === 'invalid') reject(new CreateUserError('Entrada inválida.'));
      else reject(new CreateUserError('Cancelado.'));
    };
    stdin.on('data', onData);
  });
}

const region = process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? 'us-east-1';

const deps: CreateUserDeps = {
  env: process.env,
  password,
  isTTY: Boolean(process.stdin.isTTY),
  promptHidden,
  getAccountId: async () => {
    const out = await new STSClient({ region }).send(new GetCallerIdentityCommand({}));
    return out.Account;
  },
  getStackOutputs: async (stackName) => {
    const { Stacks } = await new CloudFormationClient({ region }).send(
      new DescribeStacksCommand({ StackName: stackName }),
    );
    return Object.fromEntries(
      (Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey ?? '', o.OutputValue ?? '']),
    );
  },
  cognitoFor: (poolRegion) => {
    const client = new CognitoIdentityProviderClient({ region: poolRegion });
    return { send: (command) => client.send(command as never) };
  },
};

runCreateUser(process.argv.slice(2), deps)
  .then((lines) => {
    for (const line of lines) console.log(line);
  })
  .catch((error: unknown) => {
    // Solo los mensajes propios son seguros; cualquier otro error no se imprime tal cual.
    console.error(error instanceof CreateUserError ? error.message : 'Error inesperado.');
    process.exit(1);
  });

/**
 * Crea (o actualiza) un usuario de prueba en el User Pool del EMULADOR (Floci).
 *
 * Uso (la contraseña NO va en la línea de comandos):
 *   read -s DEV_PASSWORD; export DEV_PASSWORD
 *   npx tsx scripts/dev-users.ts <correo> <owner|staff>
 * Variables:
 *   AWS_ENDPOINT_URL  obligatoria (solo emulador; el script se niega a correr sin ella).
 *   DEV_PASSWORD      contraseña permanente (12+ caracteres con mayúscula, minúscula, número y
 *                     símbolo). NUNCA como argumento ni se imprime.
 *
 * Idempotente: si el usuario ya existe, solo asegura la contraseña y el grupo.
 * En AWS real los usuarios se crean con la invitación del dashboard (POST /admin/users/invite)
 * o desde la consola de Cognito; este script no sirve ahí a propósito.
 */
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  UsernameExistsException,
} from '@aws-sdk/client-cognito-identity-provider';

import { emulatorEndpoint, parseUsersArgs, pickAuthOutputs } from './dev-lib';

async function main(): Promise<void> {
  const { email, role, password } = parseUsersArgs(process.argv.slice(2), process.env);

  // Endpoint EXPLÍCITO y validado (localhost/127.0.0.1/IP de Floci) para todos los clientes.
  const endpoint = emulatorEndpoint(process.env);
  const stackName = 'canteras-auth-dev';
  const { Stacks } = await new CloudFormationClient({ endpoint }).send(
    new DescribeStacksCommand({ StackName: stackName }),
  );
  const outputs = Object.fromEntries(
    (Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey ?? '', o.OutputValue ?? '']),
  );
  const { userPoolId } = pickAuthOutputs(outputs, stackName);

  const cognito = new CognitoIdentityProviderClient({ endpoint });
  let created = true;
  try {
    await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: email,
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'email_verified', Value: 'true' },
        ],
        MessageAction: 'SUPPRESS',
      }),
    );
  } catch (error) {
    if (error instanceof UsernameExistsException) created = false;
    else throw error;
  }

  await cognito.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: userPoolId,
      Username: email,
      Password: password,
      Permanent: true,
    }),
  );
  await cognito.send(
    new AdminAddUserToGroupCommand({ UserPoolId: userPoolId, Username: email, GroupName: role }),
  );
  console.log(`${email}: ${created ? 'creado' : 'ya existía'}, contraseña fijada, grupo ${role}.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

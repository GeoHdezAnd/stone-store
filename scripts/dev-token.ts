/**
 * Imprime el access token de un usuario de prueba del EMULADOR (Floci) y NADA más en stdout.
 *
 * Uso (la contraseña NO va en la línea de comandos):
 *   read -s DEV_PASSWORD; export DEV_PASSWORD
 *   curl -H "Authorization: Bearer $(npx tsx scripts/dev-token.ts <correo>)" ...
 * ADVERTENCIA: el token dentro de `curl -H "…$(…)"` es visible en `ps` mientras corre curl.
 * Solo para desarrollo con el emulador.
 * Variables: AWS_ENDPOINT_URL (obligatoria, solo emulador) y DEV_PASSWORD.
 * Los mensajes de error van a stderr. Requiere el flujo USER_PASSWORD_AUTH, que el AuthStack
 * solo habilita con emulador.
 */
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';

import { emulatorEndpoint, parseTokenArgs, pickAuthOutputs } from './dev-lib';

async function main(): Promise<void> {
  const { email, password } = parseTokenArgs(process.argv.slice(2), process.env);

  // Endpoint EXPLÍCITO y validado (localhost/127.0.0.1/IP de Floci) para todos los clientes.
  const endpoint = emulatorEndpoint(process.env);
  const stackName = 'canteras-auth-dev';
  const { Stacks } = await new CloudFormationClient({ endpoint }).send(
    new DescribeStacksCommand({ StackName: stackName }),
  );
  const outputs = Object.fromEntries(
    (Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey ?? '', o.OutputValue ?? '']),
  );
  const { clientId } = pickAuthOutputs(outputs, stackName);

  const result = await new CognitoIdentityProviderClient({ endpoint }).send(
    new InitiateAuthCommand({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: clientId,
      AuthParameters: { USERNAME: email, PASSWORD: password },
    }),
  );
  const token = result.AuthenticationResult?.AccessToken;
  if (!token) {
    // Por ejemplo un desafío de MFA: no hay token que imprimir.
    throw new Error(`No se obtuvo access token (desafío: ${result.ChallengeName ?? 'ninguno'}).`);
  }
  process.stdout.write(`${token}\n`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

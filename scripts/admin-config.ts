/**
 * Genera el `config.json` del dashboard desde las salidas de los stacks desplegados.
 *
 * Uso: npx tsx scripts/admin-config.ts [--out <directorio>]
 *   por defecto escribe en apps/admin/public (desarrollo con `npm run dev`);
 *   al publicar: --out apps/admin/dist (después del build, antes de sync-site).
 * Variables: APP_ENV=dev|prod (por defecto dev). Con AWS_ENDPOINT_URL apunta a Floci.
 *
 * Solo LEE (DescribeStacks) y escribe un archivo local. Nunca copia config.example.json.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

import { buildAdminConfig, parseAdminConfigArgs, serializeAdminConfig } from './admin-config-lib';

async function readOutputs(
  client: CloudFormationClient,
  stackName: string,
): Promise<Record<string, string>> {
  const { Stacks } = await client.send(new DescribeStacksCommand({ StackName: stackName }));
  return Object.fromEntries(
    (Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey ?? '', o.OutputValue ?? '']),
  );
}

async function main(): Promise<void> {
  const args = parseAdminConfigArgs(process.argv.slice(2), process.env);
  const outDir = resolve(args.outDir);
  if (!existsSync(outDir)) {
    throw new Error(
      `No existe el directorio de salida: ${outDir} (¿corriste el build del admin?).`,
    );
  }

  // Endpoint EXPLÍCITO en emulador, para que ninguna variable redirija a AWS real.
  const client = new CloudFormationClient({
    region: args.region,
    ...(args.endpoint === undefined ? {} : { endpoint: args.endpoint }),
  });
  const authStack = `canteras-auth-${args.appEnv}`;
  const apiStack = `canteras-api-${args.appEnv}`;
  const config = buildAdminConfig({
    region: args.region,
    emulated: args.emulated,
    authStack,
    apiStack,
    authOutputs: await readOutputs(client, authStack),
    apiOutputs: await readOutputs(client, apiStack),
  });

  const file = resolve(outDir, 'config.json');
  writeFileSync(file, serializeAdminConfig(config));
  console.log(`Escrito ${file}`);
  console.log(serializeAdminConfig(config));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

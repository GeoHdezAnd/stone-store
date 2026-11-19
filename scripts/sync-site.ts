/**
 * Publica un directorio estático en el bucket del sitio público o del dashboard e invalida
 * CloudFront.
 *
 * Uso: npx tsx scripts/sync-site.ts [--target site|admin] [directorio]
 *   site  (por defecto): stack canteras-site-<env>, directorio infra/placeholder, assets _astro/
 *   admin: stack canteras-admin-site-<env>, directorio apps/admin/dist, assets assets/
 *          (antes: build del admin + `npx tsx scripts/admin-config.ts --out apps/admin/dist`)
 * También se puede elegir con SYNC_TARGET=admin.
 * Variables: APP_ENV=dev|prod (por defecto dev). Con AWS_ENDPOINT_URL apunta a Floci.
 *
 * Usa el AWS CLI (no el SDK) y `execFileSync` con argumentos en arreglo: sin shell.
 * La lógica (comandos, cabeceras de caché) vive en sync-site-lib.ts.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { buildSyncCommands, parseSyncArgs, targetConfig } from './sync-site-lib';

function aws(args: string[]): string {
  return execFileSync('aws', args, { encoding: 'utf8' });
}

function readOutputs(stackName: string): Record<string, string> {
  const raw = aws([
    'cloudformation',
    'describe-stacks',
    '--stack-name',
    stackName,
    '--query',
    'Stacks[0].Outputs',
    '--output',
    'json',
  ]);
  const outputs = JSON.parse(raw) as { OutputKey: string; OutputValue: string }[] | null;
  return Object.fromEntries((outputs ?? []).map((o) => [o.OutputKey, o.OutputValue]));
}

function requireOutput(outputs: Record<string, string>, key: string, stack: string): string {
  const value = outputs[key];
  if (!value) throw new Error(`El stack ${stack} no tiene la salida "${key}". ¿Se desplegó?`);
  return value;
}

function main(): void {
  const args = parseSyncArgs(process.argv.slice(2), process.env);
  const config = targetConfig(args.target, args.appEnv);

  const dir = resolve(args.dir ?? config.defaultDir);
  if (!existsSync(dir)) throw new Error(`No existe el directorio a publicar: ${dir}`);
  for (const file of config.required) {
    if (!existsSync(join(dir, file))) {
      const hint =
        file === 'config.json' ? ' Genéralo con: npx tsx scripts/admin-config.ts --out <dir>.' : '';
      throw new Error(`Falta ${file} en ${dir}.${hint}`);
    }
  }

  const outputs = readOutputs(config.stackName);
  const bucket = requireOutput(outputs, 'BucketName', config.stackName);
  const distributionId = requireOutput(outputs, 'DistributionId', config.stackName);

  for (const command of buildSyncCommands({ dir, bucket, distributionId, config })) {
    aws(command);
  }
  console.log(`Publicado ${dir} en s3://${bucket} e invalidada la distribución ${distributionId}.`);
}

main();

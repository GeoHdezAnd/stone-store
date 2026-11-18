/**
 * Publica un directorio estático en el bucket del SiteStack e invalida CloudFront.
 *
 * Uso: npx tsx scripts/sync-site.ts [directorio]   (por defecto: infra/placeholder)
 * Variables: APP_ENV=dev|prod (por defecto dev). Con AWS_ENDPOINT_URL apunta a Floci.
 *
 * Usa el AWS CLI (no el SDK) y `execFileSync` con argumentos en arreglo: sin shell.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const IMMUTABLE = 'public, max-age=31536000, immutable';
const NO_CACHE = 'no-cache';

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
  const appEnv = process.env['APP_ENV'] ?? 'dev';
  if (appEnv !== 'dev' && appEnv !== 'prod') {
    throw new Error(`APP_ENV inválido: "${appEnv}". Usa "dev" o "prod".`);
  }
  // Misma salvaguarda que infra/lib/config.ts: prod nunca contra un emulador.
  if (appEnv === 'prod' && process.env['AWS_ENDPOINT_URL']) {
    throw new Error('APP_ENV=prod no puede usar AWS_ENDPOINT_URL (emulador).');
  }

  const dir = resolve(process.argv[2] ?? 'infra/placeholder');
  if (!existsSync(dir)) throw new Error(`No existe el directorio a publicar: ${dir}`);

  // Debe coincidir con el id del stack en infra/bin/app.ts.
  const stackName = `canteras-site-${appEnv}`;
  const outputs = readOutputs(stackName);
  const bucket = requireOutput(outputs, 'BucketName', stackName);
  const distributionId = requireOutput(outputs, 'DistributionId', stackName);
  const target = `s3://${bucket}`;

  // 1) Assets con hash (Astro los emite en _astro/): cacheables para siempre.
  aws([
    's3',
    'sync',
    dir,
    target,
    '--exclude',
    '*',
    '--include',
    '_astro/*',
    '--cache-control',
    IMMUTABLE,
  ]);
  // 2) Todo lo demás (HTML, etc.): siempre revalidar. --delete limpia lo que ya no existe.
  aws([
    's3',
    'sync',
    dir,
    target,
    '--exclude',
    '_astro/*',
    '--cache-control',
    NO_CACHE,
    '--delete',
  ]);
  // 3) Invalidar para que CloudFront sirva el HTML nuevo.
  aws(['cloudfront', 'create-invalidation', '--distribution-id', distributionId, '--paths', '/*']);

  console.log(`Publicado ${dir} en ${target} e invalidada la distribución ${distributionId}.`);
}

main();

/**
 * Lógica pura de `sync-site.ts`: qué sitio se publica, con qué cabeceras de caché y qué
 * comandos de `aws s3 sync` se ejecutan. Sin AWS ni I/O, para probarla con tests unitarios.
 */

export type SiteTarget = 'site' | 'admin';

export const IMMUTABLE = 'public, max-age=31536000, immutable';
export const NO_CACHE = 'no-cache';

export interface TargetConfig {
  /** Debe coincidir con el id del stack en infra/bin/app.ts. */
  readonly stackName: string;
  readonly defaultDir: string;
  /** Prefijo de los assets con hash que emite el bundler (cacheables para siempre). */
  readonly assetPrefix: string;
  /** Archivos que el directorio DEBE tener antes de publicar. */
  readonly required: readonly string[];
  /** Archivos que nunca se suben. */
  readonly excluded: readonly string[];
}

export function targetConfig(target: SiteTarget, appEnv: 'dev' | 'prod'): TargetConfig {
  if (target === 'admin') {
    return {
      stackName: `canteras-admin-site-${appEnv}`,
      defaultDir: 'apps/admin/dist',
      assetPrefix: 'assets/',
      // Sin config.json la app muestra el error de configuración: se genera con admin-config.ts.
      required: ['index.html', 'config.json'],
      // Vite copia public/ a dist/: el ejemplo (con IDs de mentira) nunca debe publicarse.
      excluded: ['config.example.json'],
    };
  }
  return {
    stackName: `canteras-site-${appEnv}`,
    defaultDir: 'infra/placeholder',
    assetPrefix: '_astro/',
    required: ['index.html'],
    excluded: [],
  };
}

export interface SyncArgs {
  readonly target: SiteTarget;
  readonly appEnv: 'dev' | 'prod';
  /** Directorio indicado por el usuario (si no, `defaultDir` del destino). */
  readonly dir: string | undefined;
}

export const SYNC_USAGE =
  'Uso: npx tsx scripts/sync-site.ts [--target site|admin] [directorio]  (o SYNC_TARGET=admin)';

export function parseSyncArgs(argv: readonly string[], env: NodeJS.ProcessEnv): SyncArgs {
  let rawTarget = env['SYNC_TARGET'] ?? 'site';
  let dir: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--target') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(SYNC_USAGE);
      rawTarget = value;
      i += 1;
    } else if (arg.startsWith('--target=')) {
      rawTarget = arg.slice('--target='.length);
    } else if (arg.startsWith('--') || dir !== undefined) {
      throw new Error(SYNC_USAGE);
    } else {
      dir = arg;
    }
  }
  if (rawTarget !== 'site' && rawTarget !== 'admin') {
    throw new Error(`Destino inválido: "${rawTarget}". Usa "site" o "admin".`);
  }

  const appEnv = env['APP_ENV'] ?? 'dev';
  if (appEnv !== 'dev' && appEnv !== 'prod') {
    throw new Error(`APP_ENV inválido: "${appEnv}". Usa "dev" o "prod".`);
  }
  // Misma salvaguarda que infra/lib/config.ts: prod nunca contra un emulador.
  if (appEnv === 'prod' && env['AWS_ENDPOINT_URL']) {
    throw new Error('APP_ENV=prod no puede usar AWS_ENDPOINT_URL (emulador).');
  }
  return { target: rawTarget, appEnv, dir };
}

/** Argumentos de `aws` (sin el binario) para publicar: assets inmutables, resto no-cache, invalidación. */
export function buildSyncCommands(options: {
  readonly dir: string;
  readonly bucket: string;
  readonly distributionId: string;
  readonly config: TargetConfig;
}): string[][] {
  const { dir, bucket, distributionId, config } = options;
  const target = `s3://${bucket}`;
  const excludes = config.excluded.flatMap((f) => ['--exclude', f]);
  return [
    // 1) Assets con hash: cacheables para siempre. `config.json` e `index.html` nunca caen aquí.
    [
      's3',
      'sync',
      dir,
      target,
      '--exclude',
      '*',
      '--include',
      `${config.assetPrefix}*`,
      ...excludes,
      '--cache-control',
      IMMUTABLE,
    ],
    // 2) Todo lo demás (index.html, config.json, robots.txt...): siempre revalidar.
    //    --delete limpia lo que ya no existe en el directorio.
    [
      's3',
      'sync',
      dir,
      target,
      '--exclude',
      `${config.assetPrefix}*`,
      ...excludes,
      '--cache-control',
      NO_CACHE,
      '--delete',
    ],
    // 3) Invalidar para que CloudFront sirva el HTML y la configuración nuevos.
    ['cloudfront', 'create-invalidation', '--distribution-id', distributionId, '--paths', '/*'],
  ];
}

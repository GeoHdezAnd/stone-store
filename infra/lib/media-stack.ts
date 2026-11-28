import { join } from 'node:path';

import { MEDIA_ENTITIES, MEDIA_VARIANT_WIDTHS } from '@canteras/shared';
import {
  Annotations,
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from 'aws-cdk-lib';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { EventType } from 'aws-cdk-lib/aws-s3';
import { LambdaDestination } from 'aws-cdk-lib/aws-s3-notifications';
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
  HttpMethods,
  ObjectOwnership,
  type IBucket,
} from 'aws-cdk-lib/aws-s3';
import { type Construct } from 'constructs';

import { mediaBucketName } from './bucket-names.js';
import { grantCdnRead } from './cdn-grant.js';
import { type DeployEnv } from './config.js';
import { validateAllowedOrigins } from './origins.js';

/*
 * Variantes de imagen (CLAUDE.md 6.3, fase 6.3). Servicios nuevos (el dueño está aprendiendo AWS):
 * - Notificaciones de S3 -> Lambda: el bucket avisa a una Lambda cuando se crea un objeto (evento
 *   `ObjectCreated`), sin servidor ni polling. Es invocación asíncrona con reintentos acotados. Las
 *   notificaciones son gratis; se paga la invocación (~USD 0.20 por millón + tiempo de cómputo).
 *   Fuente: https://docs.aws.amazon.com/AmazonS3/latest/userguide/EventNotifications.html
 * - sharp/libvips: biblioteca de Node (binario nativo en C) que redimensiona imágenes rápido y con
 *   poca memoria. Gratis (Apache-2.0); el costo es solo el cómputo de la Lambda: ~1024 MB x ~1 s por
 *   foto ~ USD 0.00002 en arm64, es decir centavos por miles de fotos.
 *
 * Empaquetado de sharp para Lambda (fuentes vigentes, verificadas):
 * - https://sharp.pixelplumbing.com/install#aws-lambda : `node_modules` del paquete debe traer el
 *   binario de la plataforma de la función (linux-x64 o linux-arm64); recomienda memoria alta
 *   (1536 MB da ~12x el CPU de 128 MB).
 * - https://sharp.pixelplumbing.com/install#cross-platform : con npm 10+ se instala para otra
 *   plataforma con `--os`, `--cpu` y `--libc` (en Linux hay que indicar glibc).
 * - https://docs.aws.amazon.com/lambda/latest/dg/nodejs-package.html : las dependencias nativas deben
 *   compilarse para la arquitectura de la función.
 * Por eso esbuild deja `sharp` como módulo externo y un `afterBundling` lo instala en el paquete para
 * linux/arm64/glibc (el runtime Node 22 de Lambda es Amazon Linux 2023, glibc 2.34 >= 2.28 requerido).
 *
 * El empaquetado necesita RED (npm descarga el binario), así que solo ocurre con la bandera de
 * contexto `-c packSharp=true`, OBLIGATORIA fuera del emulador: sin ella el stack LANZA un error
 * (desplegar sin el binario dejaría una Lambda rota que falla con cada foto).
 *   npx cdk diff   -c packSharp=true canteras-media-dev
 *   npx cdk deploy -c packSharp=true canteras-media-dev
 * Salida explícita para `cdk synth`/`cdk diff` SIN red (p. ej. el CI): `-c skipSharpCheck=true`.
 * Solo sintetiza (deja un WARNING); NO debe usarse para desplegar.
 */

/** Versión EXACTA de sharp (debe coincidir con `services/api/package.json`; hay una prueba). */
export const SHARP_VERSION = '0.35.5';

/**
 * Memoria: sharp/libvips es CPU-bound y en Lambda el CPU crece con la memoria; 1024 MB deja holgura
 * para decodificar hasta 40 MP (~160 MB de RGBA) más los buffers de salida, y termina en ~1 s.
 */
export const VARIANTS_MEMORY_MB = 1024;

/** Tiempo máximo: una foto de 5 MiB tarda ~1-3 s; 60 s cubre S3 lento y cold start sin dejarla colgada. */
export const VARIANTS_TIMEOUT_SECONDS = 60;

/**
 * Concurrencia reservada: OPCIONAL y apagada por defecto (`-c mediaVariantsReservedConcurrency=<n>`).
 * Reservar concurrencia acota costo y abuso (alguien subiendo miles de fotos), pero la resta del
 * pool de la cuenta, que SIEMPRE debe conservar al menos 100 ejecuciones sin reservar; en una cuenta
 * nueva con un límite bajo el despliegue fallaría. Fuente:
 * https://docs.aws.amazon.com/lambda/latest/dg/lambda-concurrency.html
 * Sin reserva, el abuso lo acotan igualmente el límite de 5 MiB por foto, el presigner (ruta con
 * throttling) y la alarma de errores/throttles.
 */
export const RESERVED_CONCURRENCY_CONTEXT = 'mediaVariantsReservedConcurrency';

/** Valida el valor del contexto: vacío = apagado; entero >= 1 = reserva; cualquier otra cosa lanza. */
export function parseReservedConcurrency(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && /^\d+$/.test(raw)
        ? Number(raw)
        : NaN;
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(
      `${RESERVED_CONCURRENCY_CONTEXT} debe ser un entero >= 1 (recibido: ${String(raw)}).`,
    );
  }
  return n;
}

/** Reintentos del evento asíncrono: 1 (en vez de 2) y se descarta lo que lleve más de 1 hora. */
const VARIANTS_RETRY_ATTEMPTS = 1;
const VARIANTS_MAX_EVENT_AGE = Duration.hours(1);

const REPO_ROOT = join(import.meta.dirname, '..', '..');

/** Comando que instala sharp para la plataforma del runtime (linux, arm64, glibc) en el paquete. */
export function sharpInstallCommand(outputDir: string): string {
  return [
    'npm install',
    `--prefix "${outputDir}"`,
    '--no-save --no-package-lock --no-audit --no-fund --omit=dev',
    '--os=linux --cpu=arm64 --libc=glibc',
    `sharp@${SHARP_VERSION}`,
  ].join(' ');
}

export interface MediaStackProps extends StackProps {
  readonly deploy: DeployEnv;
  /** Instala el binario nativo de sharp (linux/arm64) en el paquete de la Lambda; requiere red. */
  readonly packSharp?: boolean;
  /**
   * SOLO para `cdk synth`/`cdk diff` sin red: omite la exigencia de `packSharp` (deja un WARNING).
   * NO debe usarse para desplegar: la Lambda quedaría sin el binario de sharp y fallaría siempre.
   */
  readonly skipSharpCheck?: boolean;
  /** Concurrencia reservada de la Lambda (entero >= 1). Sin valor, no se reserva. */
  readonly reservedConcurrency?: number;
  /** Orígenes del dashboard que pueden subir fotos con PUT (mismos que el CORS de la API). */
  readonly allowedOrigins: string[];
  /**
   * Id de la distribución de CloudFront del sitio (`SITE_DISTRIBUTION_ID`). Con él, esa distribución
   * (y solo ella) puede leer las VARIANTES WebP (`<entidad>/*-<ancho>w.webp`); los originales no.
   * Sin él no hay permiso (falla cerrado).
   */
  readonly siteDistributionId?: string;
}

/**
 * Bucket S3 de fotos (`media`): PRIVADO. Las subidas llegan por URL prefirmada que emite la
 * Lambda de administración; la lectura pública llegará después por CloudFront con OAC
 * (CLAUDE.md 6.3). S3 con poco tráfico cuesta centavos (almacenamiento por GB).
 */
export class MediaStack extends Stack {
  public readonly bucket: Bucket;
  /** Lambda que genera las variantes WebP (se pasa a ObservabilityStack para su alarma de errores). */
  public readonly variantsFunction: NodejsFunction;

  public constructor(scope: Construct, id: string, props: MediaStackProps) {
    const {
      deploy,
      allowedOrigins,
      packSharp = false,
      skipSharpCheck = false,
      reservedConcurrency,
      siteDistributionId,
      ...stackProps
    } = props;
    if (reservedConcurrency !== undefined) parseReservedConcurrency(reservedConcurrency);
    if (!deploy.emulated && !packSharp && !skipSharpCheck) {
      throw new Error(
        'MediaVariants: fuera del emulador hay que empaquetar sharp con `-c packSharp=true`; sin el ' +
          'binario nativo la Lambda quedaría rota y fallaría con cada foto. Para solo sintetizar o ' +
          'hacer `cdk diff` sin red (NO para desplegar) usa `-c skipSharpCheck=true`.',
      );
    }
    super(scope, id, stackProps);

    const origins = validateAllowedOrigins(deploy, allowedOrigins);
    if (origins.length === 0) {
      throw new Error('MediaStack requiere al menos un origen CORS en allowedOrigins.');
    }
    const ephemeral = deploy.name === 'dev';

    this.bucket = new Bucket(this, 'Bucket', {
      // Nombre fijo: SiteStack lo importa sin depender de este stack (ver `bucket-names.ts`).
      bucketName: mediaBucketName(deploy.name),
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      // ACL deshabilitadas: solo valen las políticas IAM/bucket (el dueño del bucket es dueño de todo).
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      enforceSSL: true,
      // Sin versionado: una foto reemplazada no se recupera; las claves son únicas (UUID).
      versioned: false,
      // Las subidas multiparte abandonadas siguen cobrando almacenamiento: se abortan a 1 día.
      lifecycleRules: [{ abortIncompleteMultipartUploadAfter: Duration.days(1) }],
      // CORS para el PUT directo desde el navegador con la URL prefirmada. Nunca `*`.
      // `content-type` va en la preflight; `content-length` lo pone el navegador (se incluye
      // por si algún cliente lo lista). Solo PUT: no se lee ni se borra desde el navegador.
      cors: [
        {
          allowedOrigins: origins,
          allowedMethods: [HttpMethods.PUT],
          allowedHeaders: ['content-type', 'content-length'],
          exposedHeaders: ['ETag'],
          maxAge: 3000,
        },
      ],
      // Solo `dev` puede borrar el bucket con el stack. El autodelete usa una custom resource que
      // no funciona con Floci (ECONNREFUSED al puerto 443), así que se apaga con emulador.
      removalPolicy: ephemeral ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
      autoDeleteObjects: ephemeral && !deploy.emulated,
    });

    this.variantsFunction = this.addVariantsFunction(
      deploy,
      ephemeral,
      packSharp,
      reservedConcurrency,
    );

    // Solo las variantes WebP son legibles desde CloudFront (nunca `/*`): el original con EXIF y
    // sin recomprimir da 403 aunque fallara la CloudFront Function del sitio. Las entidades y los
    // anchos salen de shared, igual que la política de escritura de la API.
    grantCdnRead({
      stack: this,
      bucket: this.bucket,
      distributionId: siteDistributionId,
      objectPatterns: MEDIA_ENTITIES.flatMap((entity) =>
        MEDIA_VARIANT_WIDTHS.map((width) => `${entity}/*-${width}w.webp`),
      ),
      emulated: deploy.emulated,
      what: 'las fotos',
    });
    new CfnOutput(this, 'MediaBucketName', { value: this.bucket.bucketName });
  }

  private addVariantsFunction(
    deploy: DeployEnv,
    ephemeral: boolean,
    packSharp: boolean,
    reservedConcurrency: number | undefined,
  ): NodejsFunction {
    // Log group explícito (NO `logRetention`: crea una custom resource que no funciona en Floci).
    const logGroup = new LogGroup(this, 'MediaVariantsLogs', {
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: ephemeral ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
    });

    const fn = new NodejsFunction(this, 'MediaVariantsFunction', {
      entry: join(REPO_ROOT, 'services', 'api', 'src', 'media-variants', 'handler.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      // arm64 (Graviton): ~20 % más barato por GB-s que x86 y sharp trae binario linux-arm64.
      // Las demás Lambdas siguen en x86; la arquitectura es por función.
      architecture: Architecture.ARM_64,
      memorySize: VARIANTS_MEMORY_MB,
      timeout: Duration.seconds(VARIANTS_TIMEOUT_SECONDS),
      ...(reservedConcurrency === undefined
        ? {}
        : { reservedConcurrentExecutions: reservedConcurrency }),
      retryAttempts: VARIANTS_RETRY_ATTEMPTS,
      maxEventAge: VARIANTS_MAX_EVENT_AGE,
      logGroup,
      environment: { MEDIA_BUCKET: this.bucket.bucketName },
      bundling: {
        minify: true,
        target: 'node22',
        // El binario nativo no se puede empaquetar con esbuild: queda fuera y se instala aparte.
        externalModules: ['sharp'],
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (_inputDir, outputDir) =>
            packSharp ? [sharpInstallCommand(outputDir)] : [],
        },
      },
    });

    // IAM de mínimo privilegio: leer originales y escribir variantes SOLO bajo los prefijos de fotos.
    // Sin List ni Delete (borrar una clave inexistente no aplica; GetObject de una clave ausente da 403).
    const prefixes = MEDIA_ENTITIES.map((p) => `${this.bucket.bucketArn}/${p}/*`);
    fn.addToRolePolicy(new PolicyStatement({ actions: ['s3:GetObject'], resources: prefixes }));
    // PutObject SOLO sobre claves de variante (`<prefijo>/*/*-<ancho>w.webp`): ni un fallo ni un abuso
    // pueden sobrescribir un original. En ARNs de S3 el `*` casa también `/`, así que el patrón vale.
    const variantResources = MEDIA_ENTITIES.flatMap((p) =>
      MEDIA_VARIANT_WIDTHS.map((w) => `${this.bucket.bucketArn}/${p}/*/*-${w}w.webp`),
    );
    fn.addToRolePolicy(
      new PolicyStatement({ actions: ['s3:PutObject'], resources: variantResources }),
    );

    // Notificación S3 -> Lambda: un filtro de PREFIJO por carpeta de fotos (2.ª capa; el freno
    // anti-bucle fuerte es `isVariantKey` en el handler, porque las variantes `.webp` caen en el mismo
    // prefijo). No se filtra por sufijo: un sufijo `.webp` no podría separar originales `.webp`
    // legítimos de variantes, y el resto de tipos ya los limita el presigner.
    // Floci no garantiza notificaciones S3 -> Lambda ni su custom resource: solo en AWS real.
    if (!deploy.emulated) {
      for (const prefix of MEDIA_ENTITIES) {
        this.bucket.addEventNotification(EventType.OBJECT_CREATED, new LambdaDestination(fn), {
          prefix: `${prefix}/`,
        });
      }
    }

    if (!packSharp && !deploy.emulated) {
      Annotations.of(this).addWarning(
        'MediaVariants: sharp NO se empaqueta (skipSharpCheck). Solo para synth/diff sin red; ' +
          'NO desplegar así: la Lambda fallaría con cada foto. Para desplegar usa -c packSharp=true.',
      );
    }
    return fn;
  }
}

/** Referencia estrecha que consume ApiStack (evita arrastrar `Bucket` completo). */
export type MediaBucketRef = Pick<IBucket, 'bucketName' | 'bucketArn'>;

import { join } from 'node:path';

import { MEDIA_ENTITIES, SETTINGS_ROW_KEYS } from '@canteras/shared';

import { CfnOutput, Duration, Fn, RemovalPolicy, Stack, Token, type StackProps } from 'aws-cdk-lib';
import {
  CfnStage,
  CorsHttpMethod,
  HttpApi,
  HttpMethod,
  HttpNoneAuthorizer,
  HttpStage,
} from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { type ITable } from 'aws-cdk-lib/aws-dynamodb';
import { type IBucket } from 'aws-cdk-lib/aws-s3';
import { type IUserPool, type IUserPoolClient } from 'aws-cdk-lib/aws-cognito';
import { Runtime, type IFunction } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { type ILogGroup, LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { type Construct } from 'constructs';

import { FLOCI_API_PORT, FLOCI_IP, type DeployEnv } from './config.js';
import { AUDIT_SCOPE_INDEX, QUOTES_BY_DATE_INDEX, QUOTES_BY_STATUS_INDEX } from './data-stack.js';
import { mergeOrigins, validateAllowedOrigins, validateSiteOrigins } from './origins.js';

// Se reexportan desde su módulo compartido (validateAllowedOrigins también lo usa MediaStack).
export { validateAllowedOrigins, validateSiteOrigins };

/**
 * Tabla de DynamoDB reducida a lo que usa esta pila (ARN y nombre). Se evita `ITable`
 * completo porque `Table` no le es asignable con `exactOptionalPropertyTypes`.
 */
type TableRef = Pick<ITable, 'tableArn' | 'tableName'>;

/** Tablas del DataStack que usa la API. */
export interface ApiTables {
  readonly stones: TableRef;
  readonly projects: TableRef;
  readonly finishes: TableRef;
  readonly services: TableRef;
  readonly settings: TableRef;
  readonly auditLog: TableRef;
  readonly publications: TableRef;
  readonly freightConfig: TableRef;
  readonly quotes: TableRef;
  /** Contadores de folio (`folio#<año>`): solo los toca `QuotesCreate`. */
  readonly counters: TableRef;
  /** Códigos postales con coordenadas: los leen `FreightEstimate` y `QuotesCreate`. */
  readonly postalCodes: TableRef;
  /** Caché de distancias por CP (TTL 90 días): la tocan `FreightEstimate` y `QuotesCreate`. */
  readonly routeCache: TableRef;
  /** Solo con emulador (DataStack): bandeja de salida de correos de desarrollo. */
  readonly mailOutbox?: TableRef;
}

/** Bucket de media reducido a lo que usa esta pila (nombre y ARN). */
type BucketRef = Pick<IBucket, 'bucketName' | 'bucketArn'>;

export interface ApiStackProps extends StackProps {
  readonly deploy: DeployEnv;
  readonly userPool: IUserPool;
  readonly userPoolClient: IUserPoolClient;
  readonly tables: ApiTables;
  /** Bucket privado de fotos (MediaStack): la Lambda de media solo puede escribir en él. */
  readonly mediaBucket: BucketRef;
  /**
   * Bucket privado y versionado del catálogo publicado (PublishStack): la Lambda de publicación
   * solo puede leer y escribir bajo `published/*`.
   */
  readonly publishBucket: BucketRef;
  /**
   * Id de la distribución de CloudFront del sitio público (salida `DistributionId` de SiteStack).
   * Opcional: sin él no se invalida nada y la Lambda no recibe permisos de CloudFront. Llega por
   * prop (no se importa SiteStack: evita una dependencia ApiStack -> SiteStack).
   */
  readonly siteDistributionId?: string;
  /**
   * ARN de la IDENTIDAD verificada de SES (`arn:aws:ses:<región>:<cuenta>:identity/<dominio o correo>`)
   * desde la que se envían las cotizaciones. Opcional: sin ella (y sin emulador) la ruta de envío
   * responde 409 `mail_not_configured` y la Lambda no recibe permisos de SES. SES en sandbox solo
   * entrega a destinatarios verificados.
   */
  readonly sesIdentityArn?: string;
  /**
   * ARNs de identidades SES de los DESTINATARIOS (opcional, vacío por defecto). En el sandbox de SES
   * el envío puede exigir permiso también sobre las identidades verificadas del destinatario (o un
   * recurso `identity/*` con la condición `ses:FromAddress`); no se asume: se confirma en el smoke
   * test del hito de AWS real. Se validan igual que `sesIdentityArn` (sin comodines).
   */
  readonly sesRecipientIdentityArns?: string[];
  /** Orígenes CORS permitidos. Obligatorio en prod; en dev por defecto el dashboard local. */
  readonly allowedOrigins?: string[];
  /**
   * Orígenes CORS del SITIO PÚBLICO (variable SITE_ORIGINS): se UNEN a los del dashboard solo en la
   * API. En dev, sin valor, `http://localhost:4321`; en prod pueden faltar (misma validación https).
   */
  readonly siteOrigins?: string[];
  /**
   * Origen del dashboard (`https://admin.ejemplo.mx`, o http con localhost) para el enlace al detalle
   * del aviso al dueño. Opcional: sin él, el aviso va sin enlace.
   */
  readonly adminBaseUrl?: string;
  /**
   * Nombre (`/ruta/nombre`) del parámetro SSM SecureString con el secreto de Cloudflare Turnstile. El
   * dueño lo crea a mano en AWS real. Opcional: sin él (y sin emulador) `POST /quotes` falla CERRADO
   * (503 `captcha_not_configured`). Con emulador se ignora: se usa el verificador falso.
   */
  readonly turnstileSecretParam?: string;
}

// Identidad de SES concreta (sin comodines).
const SES_IDENTITY_ARN_RE = /^arn:aws:ses:[a-z0-9-]+:\d{12}:identity\/[A-Za-z0-9._@+-]+$/;

// Claves de ruta de la subida de fotos (las emite `addAdminResource('media', ...)`).
const MEDIA_ROUTE_KEYS = ['ANY /admin/media', 'ANY /admin/media/{proxy+}'] as const;

// Resumen del dashboard (`GET /admin/metrics`, privado con JWT): hace varias consultas a Quotes por
// petición, así que lleva su propio límite (2 req/s, ráfaga 5) además del de la etapa. Las claves son
// EXACTAMENTE las rutas que emite `addAdminResource('metrics')`.
const METRICS_ROUTE_KEYS = ['ANY /admin/metrics', 'ANY /admin/metrics/{proxy+}'] as const;
const METRICS_THROTTLE = { ThrottlingRateLimit: 2, ThrottlingBurstLimit: 5 } as const;

// Ruta PÚBLICA del formulario de cotización: límite propio (1 req/s, ráfaga 2) además del de la etapa.
const QUOTES_CREATE_ROUTE_KEY = 'POST /quotes';

// Ruta PÚBLICA del estimado de flete: puede disparar una llamada de PAGO a Location Service (Routes),
// así que lleva su propio límite (5 req/s, ráfaga 10), más holgado que el del formulario porque el
// sitio la llama mientras el cliente escribe (con debounce) y casi siempre responde desde la caché.
const FREIGHT_ESTIMATE_ROUTE_KEY = 'POST /freight/estimate';
const FREIGHT_ESTIMATE_THROTTLE = { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 } as const;

// Nombre jerárquico de SSM: `/a/b-c_d.e`, sin comodines, sin `//` ni barra final, máx. 1011 caracteres.
// (Mismo criterio que `services/api/src/quotes-create/config.ts`; infra no importa código de runtime.)
const SSM_PARAM_NAME_RE = /^\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;

/** Origen del dashboard: https (o http solo con localhost), sin ruta, credenciales ni query. */
function validateAdminBaseUrl(raw: string): string {
  const fail = (): never => {
    throw new Error(
      'ADMIN_BASE_URL no es válida: debe ser un origen https (o http solo con localhost), sin ruta.',
    );
  };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail();
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  const schemeOk = url.protocol === 'https:' || (url.protocol === 'http:' && local);
  if (!schemeOk || !/^[a-z0-9.-]+$/i.test(url.hostname) || url.origin !== raw.replace(/\/+$/, '')) {
    fail();
  }
  return url.origin;
}

// Raíz del repo (infra/lib -> ../..): las Lambdas viven en services/api.
const REPO_ROOT = join(import.meta.dirname, '..', '..');
const handlerPath = (dir: string): string =>
  join(REPO_ROOT, 'services', 'api', 'src', dir, 'handler.ts');

/**
 * Issuer del JWT authorizer. Con emulador, Floci solo acepta un issuer HTTP con IP literal
 * (FLOCI_IP, fija en docker-compose.yml); en AWS real es el issuer estándar de Cognito.
 * Si el id del pool es un token de CDK se arma con `Fn.join`.
 */
export function jwtIssuer(
  deploy: Pick<DeployEnv, 'emulated'>,
  region: string,
  userPoolId: string,
): string {
  const prefix = deploy.emulated
    ? `http://${FLOCI_IP}:${FLOCI_API_PORT}/`
    : `https://cognito-idp.${region}.amazonaws.com/`;
  return Token.isUnresolved(userPoolId)
    ? Fn.join('', [prefix, userPoolId])
    : `${prefix}${userPoolId}`;
}

/**
 * API HTTP (API Gateway v2: punto de entrada HTTPS; ~1 USD por millón de llamadas, casi gratis
 * con poco tráfico) con Lambdas detrás.
 *
 * Denegación por defecto EN INFRAESTRUCTURA: el authorizer por defecto es JWT (Cognito), así
 * que toda ruta nueva queda protegida salvo que alguien la marque pública a propósito. Solo
 * `GET /health` y `POST /quotes` (el formulario público) son públicas. No hay ruta `$default`.
 */
export class ApiStack extends Stack {
  public readonly httpApi: HttpApi;
  public readonly healthFunction: IFunction;
  public readonly adminMeFunction: IFunction;
  public readonly adminCatalogFunction: IFunction;
  public readonly adminMediaFunction: IFunction;
  public readonly adminSettingsFunction: IFunction;
  public readonly adminPublishFunction: IFunction;
  public readonly adminFreightFunction: IFunction;
  public readonly adminQuotesFunction: IFunction;
  public readonly quotesCreateFunction: IFunction;
  public readonly freightEstimateFunction: IFunction;
  /**
   * Todas las Lambdas de la API por nombre lógico (`QuotesCreate`, `AdminMetrics`...). Las consume
   * `ObservabilityStack` para crear sus alarmas sin que ApiStack conozca ese stack (sin ciclos).
   */
  public readonly observedFunctions: Record<string, IFunction> = {};
  private readonly logGroups: Record<string, ILogGroup> = {};

  /** Grupo de logs de `QuotesCreate`: sobre él se crean los filtros de métrica de observabilidad. */
  public get quotesCreateLogGroup(): ILogGroup {
    const group = this.logGroups['QuotesCreate'];
    if (group === undefined) throw new Error('QuotesCreate aún no se ha creado.');
    return group;
  }

  public constructor(scope: Construct, id: string, props: ApiStackProps) {
    const {
      deploy,
      userPool,
      userPoolClient,
      tables,
      mediaBucket,
      publishBucket,
      siteDistributionId,
      sesIdentityArn,
      sesRecipientIdentityArns,
      allowedOrigins,
      siteOrigins,
      adminBaseUrl,
      turnstileSecretParam,
      ...stackProps
    } = props;
    super(scope, id, stackProps);

    for (const arn of [sesIdentityArn, ...(sesRecipientIdentityArns ?? [])]) {
      if (arn !== undefined && !SES_IDENTITY_ARN_RE.test(arn)) {
        throw new Error(
          'La identidad de SES no tiene el formato arn:aws:ses:<región>:<cuenta>:identity/<nombre> (sin comodines).',
        );
      }
    }

    const isProd = deploy.name === 'prod';
    // Dashboard + sitio público (SITE_ORIGINS): la API sirve a los dos; el bucket de media solo al dashboard.
    const origins = mergeOrigins(
      validateAllowedOrigins(deploy, allowedOrigins),
      validateSiteOrigins(deploy, siteOrigins),
    );
    if (
      turnstileSecretParam !== undefined &&
      (turnstileSecretParam.length > 1011 || !SSM_PARAM_NAME_RE.test(turnstileSecretParam))
    ) {
      throw new Error(
        'TURNSTILE_SECRET_PARAM no es un nombre de parámetro SSM válido: usa /ruta/nombre, sin comodines.',
      );
    }
    const adminBase = adminBaseUrl === undefined ? undefined : validateAdminBaseUrl(adminBaseUrl);

    const authorizer = new HttpJwtAuthorizer(
      'JwtAuthorizer',
      jwtIssuer(deploy, deploy.region, userPool.userPoolId),
      {
        jwtAudience: [userPoolClient.userPoolClientId],
        identitySource: ['$request.header.Authorization'],
      },
    );

    this.httpApi = new HttpApi(this, 'HttpApi', {
      // La etapa se crea aparte (abajo) para fijar throttling.
      createDefaultStage: false,
      defaultAuthorizer: authorizer,
      corsPreflight: {
        allowOrigins: origins,
        allowMethods: [
          CorsHttpMethod.GET,
          CorsHttpMethod.POST,
          CorsHttpMethod.PUT,
          CorsHttpMethod.PATCH,
          CorsHttpMethod.DELETE,
          CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['authorization', 'content-type'],
        // El dashboard lee estas cabeceras de la exportación CSV (sin esto el navegador las oculta).
        exposeHeaders: ['x-export-truncated', 'x-export-skipped', 'content-disposition'],
        maxAge: Duration.days(1),
        allowCredentials: false,
      },
    });

    // Etapa `$default` con autoDeploy y límites de peticiones. Valor inicial de MVP
    // (10 req/s, ráfaga 20); Floci NO aplica el throttling, solo cuenta en AWS real.
    const stage = new HttpStage(this, 'DefaultStage', {
      httpApi: this.httpApi,
      stageName: '$default',
      autoDeploy: true,
      throttle: { rateLimit: 10, burstLimit: 20 },
    });
    // Límite propio de la subida de fotos (1 req/s, ráfaga 2): evita que un token robado pida
    // miles de URLs prefirmadas o agote el límite de la etapa y tumbe el dashboard. `HttpStage`
    // L2 no soporta throttling por ruta: se usa el L1. Las claves son EXACTAMENTE las rutas que
    // emite `addAdminResource('media')`. Floci NO aplica throttling: solo cuenta en AWS real.
    // Lo mismo para `POST /quotes`, que es PÚBLICA: acota el abuso (spam de solicitudes y de correos).
    // API Gateway HTTP API no limita por IP, solo por ruta/etapa.
    (stage.node.defaultChild as CfnStage).routeSettings = {
      ...Object.fromEntries(
        [...MEDIA_ROUTE_KEYS, QUOTES_CREATE_ROUTE_KEY].map((k) => [
          k,
          { ThrottlingRateLimit: 1, ThrottlingBurstLimit: 2 },
        ]),
      ),
      [FREIGHT_ESTIMATE_ROUTE_KEY]: FREIGHT_ESTIMATE_THROTTLE,
      ...Object.fromEntries(METRICS_ROUTE_KEYS.map((k) => [k, METRICS_THROTTLE])),
    };

    const makeFunction = (
      name: string,
      dir: string,
      externalModules?: string[],
    ): NodejsFunction => {
      // Log group explícito (NO `logRetention`: crea una custom resource que no funciona en Floci).
      const logGroup = new LogGroup(this, `${name}Logs`, {
        retention: RetentionDays.ONE_WEEK,
        removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      });
      const fn = new NodejsFunction(this, `${name}Function`, {
        entry: handlerPath(dir),
        handler: 'handler',
        runtime: Runtime.NODEJS_22_X,
        memorySize: 256,
        timeout: Duration.seconds(10),
        logGroup,
        // esbuild local (devDependency): no requiere Docker.
        // Sin sourcemap: no se usa (NODE_OPTIONS=--enable-source-maps no está activo) y sumaba 1.4 MB por Lambda.
        bundling: {
          minify: true,
          target: 'node22',
          // `[]` = empaquetar todo. El runtime de Node 22 trae varios @aws-sdk/*, pero no se
          // garantiza `s3-request-presigner`: la Lambda de media empaqueta S3 y el presigner.
          ...(externalModules === undefined ? {} : { externalModules }),
        },
      });
      this.observedFunctions[name] = fn;
      this.logGroups[name] = logGroup;
      return fn;
    };

    this.healthFunction = makeFunction('Health', 'health');
    this.adminMeFunction = makeFunction('AdminMe', 'admin-me');

    const adminCatalog = makeFunction('AdminCatalog', 'admin-catalog');
    this.adminCatalogFunction = adminCatalog;
    adminCatalog.addEnvironment('STONES_TABLE', tables.stones.tableName);
    adminCatalog.addEnvironment('PROJECTS_TABLE', tables.projects.tableName);
    adminCatalog.addEnvironment('FINISHES_TABLE', tables.finishes.tableName);
    adminCatalog.addEnvironment('SERVICES_TABLE', tables.services.tableName);
    adminCatalog.addEnvironment('AUDIT_TABLE', tables.auditLog.tableName);

    // IAM de mínimo privilegio, sentencias explícitas (sin `grant*`) con ARNs de tabla concretos.
    // No hay GSI, así que no se incluyen ARNs de índice. NOTA: Floci NO aplica IAM; esto solo
    // se verifica en el hito de AWS real. Si allí algún camino del SDK usa una escritura fuera de
    // una transacción (EnclosingOperation ausente), hay que ajustar las condiciones aquí.
    const entidades = [tables.stones, tables.projects, tables.finishes, tables.services];
    // Las escrituras solo valen DENTRO de una TransactWriteItems (no existe una acción IAM
    // `dynamodb:TransactWriteItems`: se otorgan las acciones de las operaciones contenidas).
    const soloEnTransaccion = {
      'ForAnyValue:StringEquals': { 'dynamodb:EnclosingOperation': ['TransactWriteItems'] },
    };
    adminCatalog.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['dynamodb:GetItem', 'dynamodb:BatchGetItem', 'dynamodb:Scan'],
        resources: entidades.map((t) => t.tableArn),
      }),
    );
    adminCatalog.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem'],
        resources: entidades.map((t) => t.tableArn),
        conditions: soloEnTransaccion,
      }),
    );
    // Auditoría append-only: solo PutItem (sin lectura, Update ni Delete).
    adminCatalog.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['dynamodb:PutItem'],
        resources: [tables.auditLog.tableArn],
        conditions: soloEnTransaccion,
      }),
    );

    // Media: URLs prefirmadas de subida. La Lambda NUNCA toca los objetos: solo firma. Su rol
    // únicamente puede ESCRIBIR (`s3:PutObject`) bajo los prefijos de las entidades con fotos;
    // sin lectura, listado ni borrado, y sin acceso al resto del bucket. La URL firmada hereda
    // estos permisos del rol que firma (por eso importa que sean mínimos). Floci no aplica IAM.
    const adminMedia = makeFunction('AdminMedia', 'admin-media', []);
    this.adminMediaFunction = adminMedia;
    adminMedia.addEnvironment('MEDIA_BUCKET', mediaBucket.bucketName);
    if (deploy.emulated) {
      // Solo con emulador: firmar con el endpoint que alcanza el navegador (no el interno).
      adminMedia.addEnvironment('S3_PUBLIC_ENDPOINT', `http://localhost:${FLOCI_API_PORT}`);
    }
    adminMedia.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['s3:PutObject'],
        // Los prefijos salen de shared (MEDIA_ENTITIES): una carpeta nueva allí entra a la política.
        resources: MEDIA_ENTITIES.map((p) => `${mediaBucket.bucketArn}/${p}/*`),
      }),
    );

    // Configuración del negocio (filas únicas PUBLIC y MAIL de Settings). Lectura con `GetItem`
    // (sin Scan ni BatchGetItem: solo hay dos claves conocidas). La escritura es un `PutItem`
    // dentro de una transacción (fila + auditoría), igual que el catálogo; no hay Update, Delete
    // ni Query. Sin acceso a las tablas del catálogo ni a S3. Floci NO aplica IAM: verificar en
    // AWS real.
    const adminSettings = makeFunction('AdminSettings', 'admin-settings');
    this.adminSettingsFunction = adminSettings;
    adminSettings.addEnvironment('SETTINGS_TABLE', tables.settings.tableName);
    adminSettings.addEnvironment('AUDIT_TABLE', tables.auditLog.tableName);
    // Defensa en profundidad: solo las filas PUBLIC y MAIL (igual que AdminPublish y AdminQuotes).
    const soloFilasDeSettings = {
      'ForAllValues:StringEquals': {
        'dynamodb:LeadingKeys': [SETTINGS_ROW_KEYS.public, SETTINGS_ROW_KEYS.mail],
      },
    };
    adminSettings.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['dynamodb:GetItem'],
        resources: [tables.settings.tableArn],
        conditions: soloFilasDeSettings,
      }),
    );
    adminSettings.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['dynamodb:PutItem'],
        resources: [tables.settings.tableArn],
        conditions: { ...soloEnTransaccion, ...soloFilasDeSettings },
      }),
    );
    adminSettings.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['dynamodb:PutItem'],
        resources: [tables.auditLog.tableArn],
        conditions: soloEnTransaccion,
      }),
    );

    // Publicar el catálogo (`catalog.json`) y revertir. Lee las 4 entidades y SOLO la fila PUBLIC
    // de Settings (la MAIL, con las plantillas de correo, queda fuera por condición de IAM);
    // Publications se lee y se escribe (PutItem solo dentro de una transacción); AuditLog solo
    // recibe PutItem en transacción y se consulta ÚNICAMENTE por el GSI disperso (sin leer
    // `antes`/`despues`). S3 solo bajo `published/*`. No toca Counters (la versión sale de la
    // fila CURRENT). Floci NO aplica IAM: verificar en AWS real.
    // Se empaqueta TODO el SDK (versiones fijadas): ni el cliente de CloudFront ni las escrituras
    // condicionales de S3 (`If-None-Match`) deben depender de la versión del SDK del runtime.
    const adminPublish = makeFunction('AdminPublish', 'admin-publish', []);
    this.adminPublishFunction = adminPublish;
    adminPublish.addEnvironment('STONES_TABLE', tables.stones.tableName);
    adminPublish.addEnvironment('PROJECTS_TABLE', tables.projects.tableName);
    adminPublish.addEnvironment('FINISHES_TABLE', tables.finishes.tableName);
    adminPublish.addEnvironment('SERVICES_TABLE', tables.services.tableName);
    adminPublish.addEnvironment('SETTINGS_TABLE', tables.settings.tableName);
    adminPublish.addEnvironment('PUBLICATIONS_TABLE', tables.publications.tableName);
    adminPublish.addEnvironment('AUDIT_TABLE', tables.auditLog.tableName);
    adminPublish.addEnvironment('AUDIT_SCOPE_INDEX', AUDIT_SCOPE_INDEX);
    adminPublish.addEnvironment('PUBLISH_BUCKET', publishBucket.bucketName);
    if (siteDistributionId !== undefined && siteDistributionId !== '') {
      adminPublish.addEnvironment('SITE_DISTRIBUTION_ID', siteDistributionId);
    }
    adminPublish.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['dynamodb:Scan'],
        resources: entidades.map((t) => t.tableArn),
      }),
    );
    adminPublish.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['dynamodb:GetItem'],
        resources: [tables.settings.tableArn],
        // Solo la fila PUBLIC: la MAIL (plantillas) nunca se publica.
        conditions: {
          'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [SETTINGS_ROW_KEYS.public] },
        },
      }),
    );
    adminPublish.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['dynamodb:GetItem', 'dynamodb:BatchGetItem'],
        resources: [tables.publications.tableArn],
      }),
    );
    adminPublish.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['dynamodb:PutItem'],
        resources: [tables.publications.tableArn],
        conditions: soloEnTransaccion,
      }),
    );
    adminPublish.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['dynamodb:PutItem'],
        resources: [tables.auditLog.tableArn],
        conditions: soloEnTransaccion,
      }),
    );
    adminPublish.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['dynamodb:Query'],
        resources: [`${tables.auditLog.tableArn}/index/${AUDIT_SCOPE_INDEX}`],
      }),
    );
    adminPublish.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['s3:GetObject', 's3:PutObject'],
        resources: [`${publishBucket.bucketArn}/published/*`],
      }),
    );
    if (siteDistributionId !== undefined && siteDistributionId !== '') {
      adminPublish.addToRolePolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ['cloudfront:CreateInvalidation'],
          // Solo ESA distribución (CloudFront es global: sin región).
          resources: [
            this.formatArn({
              service: 'cloudfront',
              region: '',
              resource: 'distribution',
              resourceName: siteDistributionId,
            }),
          ],
        }),
      );
    }

    // Tarifas de flete (versiones `tNNNN` + fila puntero ACTIVE) y simulador. FreightConfig se lee
    // con GetItem/BatchGetItem (sin Scan ni Query: las versiones son consecutivas y se piden por
    // clave) y se escribe con PutItem SOLO dentro de una transacción (versión + puntero +
    // auditoría; o puntero + auditoría al activar). Stones: solo lectura por clave (el simulador
    // calcula el peso en el servidor con los datos del catálogo). AuditLog: PutItem en
    // transacción. Sin S3, sin Counters, sin las demás tablas. Floci NO aplica IAM: verificar en
    // AWS real.
    const adminFreight = makeFunction('AdminFreight', 'admin-freight');
    this.adminFreightFunction = adminFreight;
    adminFreight.addEnvironment('FREIGHT_CONFIG_TABLE', tables.freightConfig.tableName);
    adminFreight.addEnvironment('STONES_TABLE', tables.stones.tableName);
    adminFreight.addEnvironment('AUDIT_TABLE', tables.auditLog.tableName);
    adminFreight.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['dynamodb:GetItem', 'dynamodb:BatchGetItem'],
        resources: [tables.freightConfig.tableArn],
      }),
    );
    adminFreight.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['dynamodb:PutItem'],
        resources: [tables.freightConfig.tableArn],
        conditions: soloEnTransaccion,
      }),
    );
    adminFreight.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['dynamodb:BatchGetItem'],
        resources: [tables.stones.tableArn],
      }),
    );
    adminFreight.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['dynamodb:PutItem'],
        resources: [tables.auditLog.tableArn],
        conditions: soloEnTransaccion,
      }),
    );

    // Solicitudes de cotización (datos personales: nombre, teléfono, correo). Mínimo privilegio:
    // Quotes se lee con GetItem (detalle) y Query SOLO sobre sus 2 índices (lista y CSV; no la
    // tabla base, ni Scan); se escribe con PutItem SOLO dentro de una transacción (solicitud con
    // condición de `rev` + auditoría; el reclamo/liberación del candado de envío es un Put
    // condicionado sin auditoría). AuditLog: PutItem en transacción. Settings: solo GetItem de las
    // filas PUBLIC y MAIL (abajo). Transporte de correo: SES con `ses:SendEmail` sobre la identidad
    // configurada, u outbox DynamoDB con emulador (abajo). Sin Stones, Counters (el folio lo genera
    // el flujo de creación de la fase 4 y el seed) ni S3. Floci NO aplica IAM: verificar en AWS real.
    const adminQuotes = makeFunction('AdminQuotes', 'admin-quotes');
    this.adminQuotesFunction = adminQuotes;
    adminQuotes.addEnvironment('QUOTES_TABLE', tables.quotes.tableName);
    adminQuotes.addEnvironment('AUDIT_TABLE', tables.auditLog.tableName);
    adminQuotes.addEnvironment('QUOTES_BY_STATUS_INDEX', QUOTES_BY_STATUS_INDEX);
    adminQuotes.addEnvironment('QUOTES_BY_DATE_INDEX', QUOTES_BY_DATE_INDEX);
    adminQuotes.addEnvironment('SETTINGS_TABLE', tables.settings.tableName);
    // Settings: solo GetItem de las filas PUBLIC (remitente, patio) y MAIL (plantilla) para armar el
    // correo de la cotización.
    adminQuotes.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['dynamodb:GetItem'],
        resources: [tables.settings.tableArn],
        conditions: {
          'ForAllValues:StringEquals': {
            'dynamodb:LeadingKeys': [SETTINGS_ROW_KEYS.public, SETTINGS_ROW_KEYS.mail],
          },
        },
      }),
    );
    // Transporte de correo: emulador -> bandeja `MailOutbox` (DynamoDB); AWS real -> SES, solo si hay
    // identidad configurada; si no, ninguna variable y la ruta responde 409 `mail_not_configured`.
    if (deploy.emulated && tables.mailOutbox) {
      adminQuotes.addEnvironment('MAIL_TRANSPORT', 'outbox');
      adminQuotes.addEnvironment('MAIL_OUTBOX_TABLE', tables.mailOutbox.tableName);
      adminQuotes.addToRolePolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ['dynamodb:PutItem'],
          resources: [tables.mailOutbox.tableArn],
        }),
      );
    } else if (!deploy.emulated && sesIdentityArn !== undefined) {
      adminQuotes.addEnvironment('MAIL_TRANSPORT', 'ses');
      adminQuotes.addToRolePolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ['ses:SendEmail'],
          // Remitente y, solo si se pasan, identidades de destinatarios (sandbox; ver la prop).
          resources: [sesIdentityArn, ...(sesRecipientIdentityArns ?? [])],
        }),
      );
    }
    adminQuotes.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['dynamodb:GetItem'],
        resources: [tables.quotes.tableArn],
      }),
    );
    adminQuotes.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['dynamodb:Query'],
        resources: [QUOTES_BY_STATUS_INDEX, QUOTES_BY_DATE_INDEX].map(
          (i) => `${tables.quotes.tableArn}/index/${i}`,
        ),
      }),
    );
    adminQuotes.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['dynamodb:PutItem'],
        resources: [tables.quotes.tableArn],
        conditions: soloEnTransaccion,
      }),
    );
    adminQuotes.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['dynamodb:PutItem'],
        resources: [tables.auditLog.tableArn],
        conditions: soloEnTransaccion,
      }),
    );

    // Resumen del dashboard (`GET /admin/metrics`): SOLO LECTURA. IAM mínimo y explícito (sin `grant*`):
    // - Quotes: `Query` únicamente sobre el ARN del índice `byStatus` (consulta por cada estado; no
    //   usa `byDate`, ni la tabla base, ni GetItem, ni Scan, ni escrituras).
    // - PostalCodes: `BatchGetItem` (código postal -> estado para la tabla de zonas).
    // Sin AuditLog, Settings, Counters ni S3. Floci NO aplica IAM: verificar en AWS real.
    const adminMetrics = makeFunction('AdminMetrics', 'admin-metrics');
    adminMetrics.addEnvironment('QUOTES_TABLE', tables.quotes.tableName);
    adminMetrics.addEnvironment('QUOTES_BY_STATUS_INDEX', QUOTES_BY_STATUS_INDEX);
    adminMetrics.addEnvironment('POSTAL_CODES_TABLE', tables.postalCodes.tableName);
    adminMetrics.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['dynamodb:Query'],
        resources: [`${tables.quotes.tableArn}/index/${QUOTES_BY_STATUS_INDEX}`],
      }),
    );
    adminMetrics.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['dynamodb:BatchGetItem'],
        resources: [tables.postalCodes.tableArn],
      }),
    );

    // Formulario público de cotización (`POST /quotes`, CLAUDE.md 5.1 y 8): ruta SIN authorizer que
    // escribe en la base y manda correos. Mínimo privilegio con sentencias explícitas (sin `grant*`):
    // - Quotes: solo `PutItem` (crea la solicitud; no lee, consulta, actualiza ni borra).
    // - Counters: `UpdateItem` solo en claves `folio#*` (folios) y `rate#*` (límite de solicitudes por
    //   correo e IP, con `ttl`), y `GetItem` solo en `folio#*` (folio señuelo del honeypot).
    // - Stones: `BatchGetItem` (las piedras pedidas, para calcular el peso en el servidor).
    // - FreightConfig: `GetItem` (puntero ACTIVE y versión activa: de ahí sale la merma).
    // - Settings: `GetItem` de la fila PUBLIC (remitente y patio; nunca la MAIL).
    // - Estimado de flete guardado en la solicitud (best-effort, recalculado en el servidor con la
    //   misma lógica que `FreightEstimate`): PostalCodes `GetItem`; RouteCache `GetItem` y `PutItem`;
    //   y `geo-routes:CalculateRoutes` sobre el proveedor por defecto SOLO en AWS real (con emulador
    //   `ROUTE_PROVIDER=haversine`). Solo se paga una ruta tras captcha, validación y límite.
    // - Correo: SES (`ses:SendEmail` sobre la identidad) o, con emulador, PutItem en MailOutbox.
    // - Captcha: `ssm:GetParameter` SOLO sobre el parámetro del secreto de Turnstile y solo en AWS real.
    // Sin AuditLog (el actor es anónimo; la solicitud misma es el registro), sin S3, sin KMS explícito
    // (con la llave administrada `aws/ssm` la política de la llave ya lo permite; con una CMK propia
    // habría que agregar `kms:Decrypt`). Se empaqueta TODO el SDK (versiones fijadas, SSM incluido).
    // Floci NO aplica IAM: se verifica en AWS real.
    const quotesCreate = makeFunction('QuotesCreate', 'quotes-create', []);
    this.quotesCreateFunction = quotesCreate;
    quotesCreate.addEnvironment('QUOTES_TABLE', tables.quotes.tableName);
    quotesCreate.addEnvironment('COUNTERS_TABLE', tables.counters.tableName);
    quotesCreate.addEnvironment('STONES_TABLE', tables.stones.tableName);
    quotesCreate.addEnvironment('FREIGHT_CONFIG_TABLE', tables.freightConfig.tableName);
    quotesCreate.addEnvironment('SETTINGS_TABLE', tables.settings.tableName);
    quotesCreate.addEnvironment('POSTAL_CODES_TABLE', tables.postalCodes.tableName);
    quotesCreate.addEnvironment('ROUTE_CACHE_TABLE', tables.routeCache.tableName);
    quotesCreate.addEnvironment('ROUTE_PROVIDER', deploy.emulated ? 'haversine' : 'location');
    if (adminBase !== undefined) quotesCreate.addEnvironment('ADMIN_BASE_URL', adminBase);
    quotesCreate.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['dynamodb:PutItem'],
        resources: [tables.quotes.tableArn],
      }),
    );
    quotesCreate.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['dynamodb:UpdateItem'],
        resources: [tables.counters.tableArn],
        // Defensa en profundidad: solo los contadores de folio (`folio#<año>`) y los del límite de
        // solicitudes (`rate#email#...`, `rate#ip#...`, con atributo `ttl`).
        conditions: {
          'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['folio#*', 'rate#*'] },
        },
      }),
    );
    quotesCreate.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        // Solo LEE el contador del folio: el folio señuelo del honeypot se parece al real.
        actions: ['dynamodb:GetItem'],
        resources: [tables.counters.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['folio#*'] } },
      }),
    );
    quotesCreate.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['dynamodb:BatchGetItem'],
        resources: [tables.stones.tableArn],
      }),
    );
    quotesCreate.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['dynamodb:GetItem'],
        resources: [tables.freightConfig.tableArn],
      }),
    );
    quotesCreate.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['dynamodb:GetItem'],
        resources: [tables.settings.tableArn],
        // Solo la fila PUBLIC: la MAIL (plantillas) no hace falta aquí.
        conditions: {
          'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [SETTINGS_ROW_KEYS.public] },
        },
      }),
    );
    for (const [actions, table] of [
      [['dynamodb:GetItem'], tables.postalCodes],
      [['dynamodb:GetItem', 'dynamodb:PutItem'], tables.routeCache],
    ] as const) {
      quotesCreate.addToRolePolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [...actions],
          resources: [table.tableArn],
        }),
      );
    }
    if (!deploy.emulated) {
      quotesCreate.addToRolePolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ['geo-routes:CalculateRoutes'],
          // `arn:<partición>:geo-routes:<región>::provider/default` (sin cuenta: es un proveedor de AWS).
          resources: [
            this.formatArn({
              service: 'geo-routes',
              account: '',
              resource: 'provider',
              resourceName: 'default',
            }),
          ],
        }),
      );
    }
    if (deploy.emulated) {
      // Emulador: correo a la bandeja MailOutbox y verificador de captcha falso (token `test-pass`).
      // NUNCA existe en AWS real: es lo que impide aceptar solicitudes sin verificar.
      quotesCreate.addEnvironment('TURNSTILE_MODE', 'fake');
      if (tables.mailOutbox) {
        quotesCreate.addEnvironment('MAIL_TRANSPORT', 'outbox');
        quotesCreate.addEnvironment('MAIL_OUTBOX_TABLE', tables.mailOutbox.tableName);
        quotesCreate.addToRolePolicy(
          new PolicyStatement({
            effect: Effect.ALLOW,
            actions: ['dynamodb:PutItem'],
            resources: [tables.mailOutbox.tableArn],
          }),
        );
      }
    } else {
      if (sesIdentityArn !== undefined) {
        quotesCreate.addEnvironment('MAIL_TRANSPORT', 'ses');
        quotesCreate.addToRolePolicy(
          new PolicyStatement({
            effect: Effect.ALLOW,
            actions: ['ses:SendEmail'],
            resources: [sesIdentityArn, ...(sesRecipientIdentityArns ?? [])],
          }),
        );
      }
      // Sin parámetro no hay verificador real: la ruta responde 503 `captcha_not_configured`.
      if (turnstileSecretParam !== undefined) {
        quotesCreate.addEnvironment('TURNSTILE_SECRET_PARAM', turnstileSecretParam);
        // Hostnames de NUESTRO sitio (de SITE_ORIGINS, no del dashboard): la Lambda exige que el
        // `hostname` de siteverify sea uno de ellos. Sin sitio configurado (prod sin SITE_ORIGINS)
        // no hay lista y no se valida.
        const siteHostnames = [
          ...new Set(validateSiteOrigins(deploy, siteOrigins).map((o) => new URL(o).hostname)),
        ];
        if (siteHostnames.length > 0) {
          quotesCreate.addEnvironment('TURNSTILE_ALLOWED_HOSTNAMES', siteHostnames.join(','));
        }
        quotesCreate.addToRolePolicy(
          new PolicyStatement({
            effect: Effect.ALLOW,
            actions: ['ssm:GetParameter'],
            // ARN del parámetro (`arn:aws:ssm:<región>:<cuenta>:parameter/ruta/nombre`), sin comodines.
            resources: [
              this.formatArn({
                service: 'ssm',
                resource: 'parameter',
                resourceName: turnstileSecretParam.slice(1),
              }),
            ],
          }),
        );
      }
    }

    // Estimado de flete público (`POST /freight/estimate`, CLAUDE.md 7.1): ruta SIN authorizer que puede
    // disparar una llamada de pago a Amazon Location Service (servicio de mapas y rutas de AWS: la
    // distancia por carretera cuesta por solicitud, por eso hay caché en `RouteCache`). Mínimo
    // privilegio con sentencias explícitas (sin `grant*`):
    // - FreightConfig: `GetItem` (puntero ACTIVE y versión activa: camiones, zonas, origen, maxKm).
    // - Stones: `BatchGetItem` (las piedras pedidas, para calcular el peso en el servidor).
    // - PostalCodes: `GetItem` (coordenadas del destino).
    // - RouteCache: `GetItem` y `PutItem` (distancias ya calculadas, TTL 90 días).
    // - Location Service: `geo-routes:CalculateRoutes` sobre el proveedor por defecto, SOLO en AWS
    //   real (Floci no lo tiene: ahí `ROUTE_PROVIDER=haversine` calcula una aproximación local).
    // Sin Quotes, Counters, Settings, AuditLog, S3, SES ni SSM. Se empaqueta TODO el SDK (versiones
    // fijadas). Floci NO aplica IAM: se verifica en AWS real.
    const freightEstimate = makeFunction('FreightEstimate', 'freight-estimate', []);
    this.freightEstimateFunction = freightEstimate;
    freightEstimate.addEnvironment('FREIGHT_CONFIG_TABLE', tables.freightConfig.tableName);
    freightEstimate.addEnvironment('STONES_TABLE', tables.stones.tableName);
    freightEstimate.addEnvironment('POSTAL_CODES_TABLE', tables.postalCodes.tableName);
    freightEstimate.addEnvironment('ROUTE_CACHE_TABLE', tables.routeCache.tableName);
    freightEstimate.addEnvironment('ROUTE_PROVIDER', deploy.emulated ? 'haversine' : 'location');
    for (const [actions, table] of [
      [['dynamodb:GetItem'], tables.freightConfig],
      [['dynamodb:BatchGetItem'], tables.stones],
      [['dynamodb:GetItem'], tables.postalCodes],
      [['dynamodb:GetItem', 'dynamodb:PutItem'], tables.routeCache],
    ] as const) {
      freightEstimate.addToRolePolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [...actions],
          resources: [table.tableArn],
        }),
      );
    }
    if (!deploy.emulated) {
      freightEstimate.addToRolePolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ['geo-routes:CalculateRoutes'],
          // `arn:<partición>:geo-routes:<región>::provider/default` (sin cuenta: es un proveedor de AWS).
          resources: [
            this.formatArn({
              service: 'geo-routes',
              account: '',
              resource: 'provider',
              resourceName: 'default',
            }),
          ],
        }),
      );
    }

    // Rutas públicas, marcadas explícitamente: `GET /health`, `POST /quotes` y `POST /freight/estimate`. Cualquier otra ruta
    // sin authorizer rompe el invariante de api-stack.test.ts.
    this.httpApi.addRoutes({
      path: '/health',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('HealthIntegration', this.healthFunction),
      authorizer: new HttpNoneAuthorizer(),
    });
    this.httpApi.addRoutes({
      path: '/quotes',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('QuotesCreateIntegration', quotesCreate),
      authorizer: new HttpNoneAuthorizer(),
    });
    this.httpApi.addRoutes({
      path: '/freight/estimate',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('FreightEstimateIntegration', freightEstimate),
      authorizer: new HttpNoneAuthorizer(),
    });

    // Rutas de administración: heredan el authorizer JWT por defecto. La Lambda además
    // verifica el rol (defensa en profundidad).
    const addAdminResource = (resource: string, fn: IFunction): void => {
      const integration = new HttpLambdaIntegration(`Admin-${resource}-Integration`, fn);
      for (const path of [`/admin/${resource}`, `/admin/${resource}/{proxy+}`]) {
        this.httpApi.addRoutes({ path, methods: [HttpMethod.ANY], integration });
      }
    };
    addAdminResource('me', this.adminMeFunction);
    addAdminResource('media', adminMedia);
    addAdminResource('settings', adminSettings);
    addAdminResource('publish', adminPublish);
    addAdminResource('publications', adminPublish);
    addAdminResource('freight-config', adminFreight);
    addAdminResource('freight', adminFreight);
    addAdminResource('quotes', adminQuotes);
    addAdminResource('metrics', adminMetrics);
    for (const resource of ['stones', 'projects', 'finishes', 'services']) {
      addAdminResource(resource, adminCatalog);
    }

    new CfnOutput(this, 'ApiUrl', { value: this.httpApi.apiEndpoint });
    new CfnOutput(this, 'HttpApiId', { value: this.httpApi.httpApiId });
  }
}

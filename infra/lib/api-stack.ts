import { join } from 'node:path';

import { MEDIA_ENTITIES } from '@canteras/shared';

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
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { type Construct } from 'constructs';

import { FLOCI_API_PORT, FLOCI_IP, type DeployEnv } from './config.js';
import { validateAllowedOrigins } from './origins.js';

// Se reexporta desde su módulo compartido (también lo usa MediaStack).
export { validateAllowedOrigins };

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
  readonly auditLog: TableRef;
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
  /** Orígenes CORS permitidos. Obligatorio en prod; en dev por defecto el dashboard local. */
  readonly allowedOrigins?: string[];
}

// Claves de ruta de la subida de fotos (las emite `addAdminResource('media', ...)`).
const MEDIA_ROUTE_KEYS = ['ANY /admin/media', 'ANY /admin/media/{proxy+}'] as const;

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
 * `GET /health` es pública. No hay ruta `$default`.
 */
export class ApiStack extends Stack {
  public readonly httpApi: HttpApi;
  public readonly healthFunction: IFunction;
  public readonly adminMeFunction: IFunction;
  public readonly adminCatalogFunction: IFunction;
  public readonly adminMediaFunction: IFunction;

  public constructor(scope: Construct, id: string, props: ApiStackProps) {
    const { deploy, userPool, userPoolClient, tables, mediaBucket, allowedOrigins, ...stackProps } =
      props;
    super(scope, id, stackProps);

    const isProd = deploy.name === 'prod';
    const origins = validateAllowedOrigins(deploy, allowedOrigins);

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
    (stage.node.defaultChild as CfnStage).routeSettings = Object.fromEntries(
      MEDIA_ROUTE_KEYS.map((k) => [k, { ThrottlingRateLimit: 1, ThrottlingBurstLimit: 2 }]),
    );

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
      return new NodejsFunction(this, `${name}Function`, {
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

    // ÚNICA ruta pública, marcada explícitamente.
    this.httpApi.addRoutes({
      path: '/health',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('HealthIntegration', this.healthFunction),
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
    for (const resource of ['stones', 'projects', 'finishes', 'services']) {
      addAdminResource(resource, adminCatalog);
    }

    new CfnOutput(this, 'ApiUrl', { value: this.httpApi.apiEndpoint });
    new CfnOutput(this, 'HttpApiId', { value: this.httpApi.httpApiId });
  }
}

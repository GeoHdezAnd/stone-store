import { CfnOutput, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { AttributeType, BillingMode, ProjectionType, Table } from 'aws-cdk-lib/aws-dynamodb';
import { type Construct } from 'constructs';

import { type DeployEnv } from './config.js';

/**
 * GSI disperso de AuditLog: `scope` (partición) + `sk` (orden por fecha). Solo se indexan los
 * ítems que tienen `scope` (`CATALOG`: lo que entra a catalog.json), para listar los «cambios
 * pendientes de publicar» con una Query en vez de escanear la auditoría completa.
 */
export const AUDIT_SCOPE_INDEX = 'scope-sk-index';

/**
 * Índices de `Quotes`. `byStatus`: gsi1pk = `STATUS#<estado>`, gsi1sk = `createdAt#quoteId` (lista
 * por estado). `byDate`: gsi2pk = `QUOTE` (constante), gsi2sk = `createdAt#quoteId` (lista general
 * por fecha). Proyección ALL: la lista y el CSV leen la solicitud completa del índice. La
 * partición constante `QUOTE` es una partición caliente por diseño: aceptable al volumen de una
 * cantera (≈ cientos de solicitudes al año, muy por debajo de 1000 WCU/3000 RCU por partición).
 */
export const QUOTES_BY_STATUS_INDEX = 'byStatus';
export const QUOTES_BY_DATE_INDEX = 'byDate';

export interface DataStackProps extends StackProps {
  readonly deploy: DeployEnv;
}

/**
 * Datos del negocio en DynamoDB (on-demand: pagas por uso, casi gratis con poco tráfico).
 * Índices secundarios solo en `AuditLog` (GSI disperso) y `Quotes` (2 GSI). TTL solo en `Counters`
 * (límite de solicitudes) y `RouteCache` (distancias por CP, 90 días).
 */
export class DataStack extends Stack {
  public readonly stones: Table;
  public readonly projects: Table;
  public readonly finishes: Table;
  public readonly services: Table;
  public readonly settings: Table;
  public readonly auditLog: Table;
  public readonly publications: Table;
  public readonly counters: Table;
  public readonly freightConfig: Table;
  public readonly quotes: Table;
  public readonly postalCodes: Table;
  public readonly routeCache: Table;
  /** Solo con emulador: bandeja de salida de correos de desarrollo (ver `OutboxMailer`). */
  public readonly mailOutbox?: Table;

  public constructor(scope: Construct, id: string, props: DataStackProps) {
    const { deploy, ...stackProps } = props;
    super(scope, id, stackProps);

    const isProd = deploy.name === 'prod';

    // dev se borra con el stack; prod se conserva y no se puede borrar por accidente.
    // PITR (respaldo continuo) solo en prod y no en el emulador, que no lo soporta.
    const common = {
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      deletionProtection: isProd,
      ...(isProd && !deploy.emulated
        ? { pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true } }
        : {}),
    };

    const string = (name: string) => ({ name, type: AttributeType.STRING });
    const make = (
      logicalId: string,
      partitionKey: ReturnType<typeof string>,
      sortKey?: ReturnType<typeof string>,
      timeToLiveAttribute?: string,
    ) => {
      const table = new Table(this, logicalId, {
        ...common,
        partitionKey,
        ...(sortKey ? { sortKey } : {}),
        ...(timeToLiveAttribute ? { timeToLiveAttribute } : {}),
      });
      // Salida con nombre lógico fijo: `scripts/seed.ts` las lee para saber en qué tabla
      // escribir. No cambiar estos ids sin ajustar el script.
      new CfnOutput(this, `${logicalId}TableName`, { value: table.tableName });
      return table;
    };

    this.stones = make('Stones', string('id'));
    this.projects = make('Projects', string('id'));
    this.finishes = make('Finishes', string('id'));
    this.services = make('Services', string('id'));
    // Filas `PUBLIC` y `MAIL`.
    this.settings = make('Settings', string('key'));
    // pk = `ENTITY#<tipo>#<id>`, sk = marca de tiempo ISO.
    this.auditLog = make('AuditLog', string('pk'), string('sk'));
    // Añadir un GSI a una tabla existente es una actualización permitida de CloudFormation (un
    // GSI por actualización; la tabla se rellena en segundo plano). No toca el resto de tablas.
    // Proyección INCLUDE solo con `userId` y `accion`: nunca `antes`/`despues` (pueden traer PII).
    this.auditLog.addGlobalSecondaryIndex({
      indexName: AUDIT_SCOPE_INDEX,
      partitionKey: string('scope'),
      sortKey: string('sk'),
      projectionType: ProjectionType.INCLUDE,
      nonKeyAttributes: ['userId', 'accion'],
    });
    this.publications = make('Publications', string('version'));
    // Contadores de folio (`folio#<año>`, sin `ttl`: no expiran) y del límite de solicitudes de
    // `POST /quotes` (`rate#email#<sha256>#<día>`, `rate#ip#<sha256>#<día>`). Estos llevan el
    // atributo `ttl` (segundos epoch, ~2 días) y DynamoDB los borra solo; TTL ignora las filas que
    // no tienen el atributo, así que los folios no se ven afectados.
    this.counters = make('Counters', string('name'), undefined, 'ttl');
    // Tarifas de flete: una fila por versión inmutable (`t0001`...) y una fila puntero `ACTIVE`
    // (versión activa + última creada). La «activa única» es atómica: ver services/api/src/admin-freight.
    this.freightConfig = make('FreightConfig', string('version'));
    // Solicitudes de cotización. Es una tabla NUEVA: CloudFormation permite crearla con 2 GSI en el
    // mismo despliegue (el límite de un GSI por actualización aplica solo a tablas existentes).
    // Los folios salen de `Counters` (`folio#<año>`).
    this.quotes = make('Quotes', string('quoteId'));
    // Códigos postales (`cp`, estado, municipio, colonia, lat, lng): de aquí sale el destino del
    // estimado de flete. Se carga con `scripts/seed-postal-codes.ts` (hoy solo datos de ejemplo).
    this.postalCodes = make('PostalCodes', string('cp'));
    // Caché de distancias por carretera por CP (`cp`, `distanciaKm`, `origen`, `calculadoAt`, `ttl`):
    // evita repetir llamadas de pago a Location Service. DynamoDB borra solo las filas vencidas
    // (`ttl` = segundos epoch, ~90 días).
    this.routeCache = make('RouteCache', string('cp'), undefined, 'ttl');
    // Bandeja de salida de correos SOLO para el emulador: Floci puede no soportar SES, así que ahí
    // `OutboxMailer` guarda el correo renderizado (con datos de ejemplo) en esta tabla. No existe en
    // AWS real, donde se envía con SES.
    if (deploy.emulated) this.mailOutbox = make('MailOutbox', string('messageId'));
    for (const [indexName, pk, sk] of [
      [QUOTES_BY_STATUS_INDEX, 'gsi1pk', 'gsi1sk'],
      [QUOTES_BY_DATE_INDEX, 'gsi2pk', 'gsi2sk'],
    ] as const) {
      this.quotes.addGlobalSecondaryIndex({
        indexName,
        partitionKey: string(pk),
        sortKey: string(sk),
        projectionType: ProjectionType.ALL,
      });
    }
  }
}

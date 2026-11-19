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

export interface DataStackProps extends StackProps {
  readonly deploy: DeployEnv;
}

/**
 * Datos del negocio en DynamoDB (on-demand: pagas por uso, casi gratis con poco tráfico).
 * Un solo índice secundario por ahora (el GSI disperso de AuditLog) y sin TTL; el resto llega con
 * las fases que lo necesiten (`Quotes` se agrega en la fase 3.3).
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
    ) => {
      const table = new Table(this, logicalId, {
        ...common,
        partitionKey,
        ...(sortKey ? { sortKey } : {}),
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
    this.counters = make('Counters', string('name'));
    // Tarifas de flete: una fila por versión inmutable (`t0001`...) y una fila puntero `ACTIVE`
    // (versión activa + última creada). La «activa única» es atómica: ver services/api/src/admin-freight.
    this.freightConfig = make('FreightConfig', string('version'));
  }
}

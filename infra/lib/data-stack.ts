import { CfnOutput, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { type Construct } from 'constructs';

import { type DeployEnv } from './config.js';

export interface DataStackProps extends StackProps {
  readonly deploy: DeployEnv;
}

/**
 * Datos del negocio en DynamoDB (on-demand: pagas por uso, casi gratis con poco tráfico).
 * Sin índices secundarios ni TTL por ahora; llegan con las fases que los necesiten
 * (`Quotes` y `FreightConfig` se agregan en la fase 3).
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
    this.publications = make('Publications', string('version'));
    this.counters = make('Counters', string('name'));
  }
}

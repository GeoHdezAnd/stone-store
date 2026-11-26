import { App, Tags } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import { ApiStack, validateAllowedOrigins } from '../api-stack.js';
import { AuthStack } from '../auth-stack.js';
import { DataStack } from '../data-stack.js';
import { MediaStack } from '../media-stack.js';
import {
  API_5XX_THRESHOLD,
  FOLIO_EXHAUSTED_FILTER,
  LOG_METRIC_NAMESPACE,
  ObservabilityStack,
  QUOTES_CREATE_DURATION_THRESHOLD_MS,
  RATE_LIMITED_FILTER,
  RATE_LIMITED_THRESHOLD,
  RATE_LIMITED_WINDOW_MINUTES,
  parseAlertEmail,
} from '../observability-stack.js';
import { PublishStack } from '../publish-stack.js';

const EMAIL = 'alertas@example.com';

interface BuildOptions {
  emulated?: boolean;
  alertEmail?: string;
  name?: 'dev' | 'prod';
  /** Incluye la Lambda `MediaVariants` (del MediaStack) entre las funciones observadas. */
  withMediaVariants?: boolean;
}

function build(opts: BuildOptions = {}): { template: Template; stack: ObservabilityStack } {
  const { emulated = false, alertEmail, name = 'dev', withMediaVariants = false } = opts;
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const deploy = { name, account: undefined, region: 'us-east-1', emulated } as const;
  const auth = new AuthStack(app, 'Auth', { deploy });
  const data = new DataStack(app, 'Data', { deploy });
  const media = new MediaStack(app, 'Media', {
    skipSharpCheck: true,
    deploy,
    allowedOrigins: validateAllowedOrigins(deploy, undefined),
  });
  const publish = new PublishStack(app, 'Publish', { deploy });
  const api = new ApiStack(app, 'Api', {
    deploy,
    userPool: auth.userPool,
    userPoolClient: auth.userPoolClient,
    mediaBucket: media.bucket,
    publishBucket: publish.bucket,
    tables: {
      stones: data.stones,
      projects: data.projects,
      finishes: data.finishes,
      services: data.services,
      settings: data.settings,
      auditLog: data.auditLog,
      publications: data.publications,
      freightConfig: data.freightConfig,
      quotes: data.quotes,
      counters: data.counters,
      postalCodes: data.postalCodes,
      routeCache: data.routeCache,
      ...(data.mailOutbox ? { mailOutbox: data.mailOutbox } : {}),
    },
  });
  const stack = new ObservabilityStack(app, 'Obs', {
    deploy,
    httpApi: api.httpApi,
    functions: withMediaVariants
      ? { ...api.observedFunctions, MediaVariants: media.variantsFunction }
      : api.observedFunctions,
    quotesCreateLogGroup: api.quotesCreateLogGroup,
    ...(alertEmail === undefined ? {} : { alertEmail }),
  });
  Tags.of(app).add('Project', 'canteras-naturales');
  Tags.of(app).add('Env', name);
  return { template: Template.fromStack(stack), stack };
}

const FUNCIONES = [
  'Health',
  'AdminMe',
  'AdminCatalog',
  'AdminMedia',
  'AdminSettings',
  'AdminPublish',
  'AdminFreight',
  'AdminQuotes',
  'AdminMetrics',
  'QuotesCreate',
];

const ACCION_SNS = [{ Ref: Match.stringLikeRegexp('^Alerts') }];

describe('parseAlertEmail', () => {
  it('devuelve undefined si la variable falta o está vacía', () => {
    expect(parseAlertEmail(undefined)).toBeUndefined();
    expect(parseAlertEmail('   ')).toBeUndefined();
  });

  it('recorta espacios y acepta un correo válido', () => {
    expect(parseAlertEmail(`  ${EMAIL} `)).toBe(EMAIL);
  });

  it.each(['no-es-correo', 'a@b', 'a b@c.com', '@c.com', 'a@@c.com', 'a@c.com,b@c.com'])(
    'rechaza el correo inválido %s',
    (raw) => {
      expect(() => parseAlertEmail(raw)).toThrow(/ALERT_EMAIL/);
    },
  );
});

describe('ObservabilityStack: destinatario', () => {
  it('falla con un mensaje claro en español fuera del emulador sin ALERT_EMAIL', () => {
    expect(() => build({ emulated: false })).toThrow(/ALERT_EMAIL.*alarmas sin destinatario/s);
  });

  it('rechaza un correo inválido', () => {
    expect(() => build({ alertEmail: 'roto' })).toThrow(/ALERT_EMAIL/);
  });

  it('en el emulador sin ALERT_EMAIL sintetiza y no crea suscripción', () => {
    const { template } = build({ emulated: true });
    template.resourceCountIs('AWS::SNS::Subscription', 0);
    template.resourceCountIs('AWS::SNS::Topic', 1);
  });

  it('sin ALERT_EMAIL no hay ningún correo literal en la plantilla', () => {
    const { template } = build({ emulated: true });
    expect(JSON.stringify(template.toJSON())).not.toMatch(/[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.[a-z]+/);
  });
});

describe('ObservabilityStack: tema SNS', () => {
  it('crea el tema y la suscripción de correo con ALERT_EMAIL', () => {
    const { template } = build({ alertEmail: EMAIL });
    template.resourceCountIs('AWS::SNS::Topic', 1);
    template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: EMAIL,
      TopicArn: { Ref: Match.stringLikeRegexp('^Alerts') },
    });
  });

  it('NO cifra el tema con la clave alias/aws/sns (CloudWatch no podría publicar)', () => {
    const { template } = build({ alertEmail: EMAIL });
    const topic = Object.values(template.findResources('AWS::SNS::Topic'))[0];
    expect(topic?.Properties).not.toHaveProperty('KmsMasterKeyId');
    expect(JSON.stringify(template.toJSON())).not.toContain('alias/aws/sns');
  });

  it('el tema lleva las etiquetas Project y Env', () => {
    const { template } = build({ alertEmail: EMAIL, name: 'dev' });
    template.hasResourceProperties('AWS::SNS::Topic', {
      Tags: Match.arrayWith([
        { Key: 'Env', Value: 'dev' },
        { Key: 'Project', Value: 'canteras-naturales' },
      ]),
    });
  });
});

describe('ObservabilityStack: alarmas de errores por Lambda', () => {
  it.each(FUNCIONES)('hay alarma de errores para %s (Sum >= 1 en 5 min)', (nombre) => {
    const { template } = build({ alertEmail: EMAIL });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: `canteras-dev-${nombre}-errors`,
      Namespace: 'AWS/Lambda',
      MetricName: 'Errors',
      Statistic: 'Sum',
      Period: 300,
      EvaluationPeriods: 1,
      Threshold: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
      Dimensions: [{ Name: 'FunctionName', Value: { 'Fn::ImportValue': Match.anyValue() } }],
      AlarmActions: ACCION_SNS,
      OKActions: ACCION_SNS,
    });
  });
});

describe('ObservabilityStack: 5xx del HttpApi', () => {
  it('alarma sobre la métrica 5xx de AWS/ApiGateway con dimensión ApiId', () => {
    const { template } = build({ alertEmail: EMAIL });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/ApiGateway',
      MetricName: '5xx',
      Statistic: 'Sum',
      Period: 300,
      EvaluationPeriods: 1,
      Threshold: API_5XX_THRESHOLD,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
      Dimensions: [{ Name: 'ApiId', Value: { 'Fn::ImportValue': Match.anyValue() } }],
      AlarmActions: ACCION_SNS,
      OKActions: ACCION_SNS,
    });
  });

  it('el umbral es una constante positiva y razonable', () => {
    expect(API_5XX_THRESHOLD).toBeGreaterThanOrEqual(1);
    expect(API_5XX_THRESHOLD).toBeLessThanOrEqual(10);
  });
});

describe('ObservabilityStack: throttles de las Lambdas públicas', () => {
  it('alarma de Throttles para QuotesCreate (>= 1)', () => {
    const { template } = build({ alertEmail: EMAIL });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'canteras-dev-QuotesCreate-throttles',
      Namespace: 'AWS/Lambda',
      MetricName: 'Throttles',
      Statistic: 'Sum',
      Period: 300,
      Threshold: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
      AlarmActions: ACCION_SNS,
      OKActions: ACCION_SNS,
    });
  });

  it('solo las públicas tienen alarma de throttles', () => {
    const { template } = build({ alertEmail: EMAIL });
    const n = Object.values(template.findResources('AWS::CloudWatch::Alarm')).filter(
      (a) => a.Properties.MetricName === 'Throttles',
    ).length;
    expect(n).toBe(1);
  });
});

describe('ObservabilityStack: duración de QuotesCreate', () => {
  it('alarma por Maximum > 8 s en 5 min (el timeout es 10 s)', () => {
    expect(QUOTES_CREATE_DURATION_THRESHOLD_MS).toBe(8000);
    const { template } = build({ alertEmail: EMAIL });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'canteras-dev-QuotesCreate-duration',
      Namespace: 'AWS/Lambda',
      MetricName: 'Duration',
      Statistic: 'Maximum',
      Period: 300,
      Threshold: 8000,
      ComparisonOperator: 'GreaterThanThreshold',
      TreatMissingData: 'notBreaching',
      AlarmActions: ACCION_SNS,
      OKActions: ACCION_SNS,
    });
  });
});

describe('ObservabilityStack: filtros de métrica sobre los logs de QuotesCreate', () => {
  it('folio_exhausted: filtro con namespace Canteras', () => {
    const { template } = build({ alertEmail: EMAIL });
    expect(LOG_METRIC_NAMESPACE).toBe('Canteras');
    expect(FOLIO_EXHAUSTED_FILTER).toBe('"folio_exhausted"');
    template.hasResourceProperties('AWS::Logs::MetricFilter', {
      FilterPattern: '"folio_exhausted"',
      LogGroupName: { 'Fn::ImportValue': Match.anyValue() },
      MetricTransformations: [
        { MetricNamespace: 'Canteras', MetricName: 'FolioExhausted', MetricValue: '1' },
      ],
    });
  });

  it('rate_limited: filtro con namespace Canteras', () => {
    const { template } = build({ alertEmail: EMAIL });
    expect(RATE_LIMITED_FILTER).toBe('"rate_limited"');
    template.hasResourceProperties('AWS::Logs::MetricFilter', {
      FilterPattern: '"rate_limited"',
      MetricTransformations: [
        { MetricNamespace: 'Canteras', MetricName: 'RateLimited', MetricValue: '1' },
      ],
    });
  });

  it('alarma de folios agotados: Sum >= 1 en 5 min', () => {
    const { template } = build({ alertEmail: EMAIL });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'canteras-dev-folio-exhausted',
      Namespace: 'Canteras',
      MetricName: 'FolioExhausted',
      Statistic: 'Sum',
      Period: 300,
      EvaluationPeriods: 1,
      Threshold: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
      AlarmActions: ACCION_SNS,
      OKActions: ACCION_SNS,
    });
  });

  it('alarma de 429: umbral por ventana de 15 min (una prueba manual no la dispara)', () => {
    expect(RATE_LIMITED_THRESHOLD).toBe(20);
    expect(RATE_LIMITED_WINDOW_MINUTES).toBe(15);
    const { template } = build({ alertEmail: EMAIL });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'canteras-dev-rate-limited',
      Namespace: 'Canteras',
      MetricName: 'RateLimited',
      Statistic: 'Sum',
      Period: 900,
      EvaluationPeriods: 1,
      Threshold: 20,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
      AlarmActions: ACCION_SNS,
      OKActions: ACCION_SNS,
    });
  });

  it('no duplica el LogGroup de QuotesCreate (el stack no crea grupos de logs)', () => {
    const { template } = build({ alertEmail: EMAIL });
    template.resourceCountIs('AWS::Logs::LogGroup', 0);
  });
});

describe('ObservabilityStack: todas las alarmas notifican al tema', () => {
  it('cada alarma tiene AlarmActions y OKActions hacia el tema, y notBreaching', () => {
    const { template } = build({ alertEmail: EMAIL });
    const alarmas = Object.values(template.findResources('AWS::CloudWatch::Alarm'));
    const topicId = Object.keys(template.findResources('AWS::SNS::Topic'))[0];
    // 10 errores + 5xx + 1 throttles + duración + folio + 429
    expect(alarmas).toHaveLength(15);
    for (const a of alarmas) {
      expect(a.Properties.TreatMissingData).toBe('notBreaching');
      expect(a.Properties.AlarmActions).toEqual([{ Ref: topicId }]);
      expect(a.Properties.OKActions).toEqual([{ Ref: topicId }]);
    }
  });
});

describe('ObservabilityStack: AWS Budgets', () => {
  it('en el emulador no se crean presupuestos', () => {
    const { template } = build({ emulated: true, alertEmail: EMAIL });
    template.resourceCountIs('AWS::Budgets::Budget', 0);
  });

  it.each([5, 10])('crea un presupuesto mensual de USD %i con avisos por correo', (usd) => {
    const { template } = build({ alertEmail: EMAIL });
    template.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({
        BudgetName: `canteras-dev-monthly-${usd}usd`,
        BudgetType: 'COST',
        TimeUnit: 'MONTHLY',
        BudgetLimit: { Amount: usd, Unit: 'USD' },
      }),
      NotificationsWithSubscribers: Match.arrayWith([
        {
          Notification: {
            NotificationType: 'ACTUAL',
            ComparisonOperator: 'GREATER_THAN',
            Threshold: 80,
            ThresholdType: 'PERCENTAGE',
          },
          Subscribers: [{ SubscriptionType: 'EMAIL', Address: EMAIL }],
        },
        {
          Notification: {
            NotificationType: 'ACTUAL',
            ComparisonOperator: 'GREATER_THAN',
            Threshold: 100,
            ThresholdType: 'PERCENTAGE',
          },
          Subscribers: [{ SubscriptionType: 'EMAIL', Address: EMAIL }],
        },
        {
          Notification: {
            NotificationType: 'FORECASTED',
            ComparisonOperator: 'GREATER_THAN',
            Threshold: 100,
            ThresholdType: 'PERCENTAGE',
          },
          Subscribers: [{ SubscriptionType: 'EMAIL', Address: EMAIL }],
        },
      ]),
    });
  });

  it('hay exactamente dos presupuestos', () => {
    const { template } = build({ alertEmail: EMAIL });
    template.resourceCountIs('AWS::Budgets::Budget', 2);
  });
});

describe('ObservabilityStack: Lambda de variantes de imagen (fase 6.3)', () => {
  it('MediaVariants tiene su alarma de errores, igual que las demás Lambdas, sin ciclos entre stacks', () => {
    const { template } = build({ emulated: true, withMediaVariants: true });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'canteras-dev-MediaVariants-errors',
      MetricName: 'Errors',
      Namespace: 'AWS/Lambda',
      Statistic: 'Sum',
      Threshold: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      AlarmActions: ACCION_SNS,
    });
  });

  it('MediaVariants tiene también alarma de throttles (>= 1 en 5 min)', () => {
    const { template } = build({ emulated: true, withMediaVariants: true });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'canteras-dev-MediaVariants-throttles',
      MetricName: 'Throttles',
      Namespace: 'AWS/Lambda',
      Statistic: 'Sum',
      Threshold: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      AlarmActions: ACCION_SNS,
    });
  });

  it('sin ella el total de alarmas no cambia (15 + 2 al incluirla: errores y throttles)', () => {
    const sin = build({ emulated: true }).template.findResources('AWS::CloudWatch::Alarm');
    const con = build({ emulated: true, withMediaVariants: true }).template.findResources(
      'AWS::CloudWatch::Alarm',
    );
    expect(Object.keys(con)).toHaveLength(Object.keys(sin).length + 2);
  });
});

import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import {
  Alarm,
  ComparisonOperator,
  type IAlarm,
  type IMetric,
  TreatMissingData,
} from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import type { HttpApi } from 'aws-cdk-lib/aws-apigatewayv2';
import { CfnBudget } from 'aws-cdk-lib/aws-budgets';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import { FilterPattern, type ILogGroup, MetricFilter } from 'aws-cdk-lib/aws-logs';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import type { Construct } from 'constructs';

import type { DeployEnv } from './config.js';

/*
 * ObservabilityStack: alarmas y presupuestos (CLAUDE.md 10 y 11, fase 6).
 *
 * Servicios nuevos (el dueño está aprendiendo AWS):
 * - CloudWatch Alarms: vigilan una métrica (p. ej. errores de una Lambda) y cambian a ALARM cuando
 *   cruza un umbral. Cuestan ~USD 0.10 por alarma al mes; las primeras 10 son gratis en la capa
 *   gratuita (aquí hay 17: ~USD 0.70 al mes).
 * - Metric filters: leen los logs de un LogGroup y cuentan las líneas que coinciden con un patrón;
 *   el conteo se publica como métrica personalizada (namespace `Canteras`). El filtro es gratis; la
 *   métrica personalizada cuesta ~USD 0.30 al mes cada una (2 métricas).
 * - SNS (Simple Notification Service): tema al que las alarmas publican y que reenvía por correo.
 *   El primer millón de publicaciones al mes es gratis y los correos no cuestan.
 * - AWS Budgets: avisa por correo cuando el gasto real o pronosticado de la CUENTA pasa de un
 *   monto. Los dos primeros presupuestos por cuenta son gratis (el segundo ya cuenta en la capa).
 *
 * Cómo desplegarlo (la variable ALERT_EMAIL es obligatoria fuera del emulador):
 *   ALERT_EMAIL=correo@dominio.com npx cdk diff   canteras-observability-dev
 *   ALERT_EMAIL=correo@dominio.com npx cdk deploy canteras-observability-dev
 * AWS manda un correo de confirmación de suscripción al tema: hay que pulsar "Confirm subscription".
 * Con el emulador (AWS_ENDPOINT_URL) el correo es opcional y no se crean suscripción ni Budgets.
 * Sin ALERT_EMAIL y sin emulador, `bin/app.ts` omite este stack (los demás sintetizan igual).
 */

/** Variable de entorno con el correo que recibe alarmas y avisos de Budgets. Nunca se guarda en el repo. */
export const ALERT_EMAIL_ENV = 'ALERT_EMAIL';

/** Namespace de las métricas personalizadas que salen de los filtros de logs. */
export const LOG_METRIC_NAMESPACE = 'Canteras';

/**
 * Patrones de los filtros. `quotes-create/create.ts` escribe `log.error('folio_exhausted', ...)` y
 * `log.warn('rate_limited', ...)`: el logger emite una línea JSON con `"msg":"<texto>"`.
 * Se usa un patrón de TÉRMINO ENTRE COMILLAS y no el patrón JSON `{ $.msg = "..." }`: el runtime de
 * Node de Lambda, en su formato de texto por defecto, antepone `fecha<TAB>requestId<TAB>NIVEL<TAB>` a
 * cada línea, y un patrón JSON solo coincide con eventos que son JSON completos (verificar con
 * `aws logs test-metric-filter`). El término funciona con ambos formatos.
 * Fuente: https://docs.aws.amazon.com/lambda/latest/dg/nodejs-logging.html
 */
export const FOLIO_EXHAUSTED_FILTER = '"folio_exhausted"';
export const RATE_LIMITED_FILTER = '"rate_limited"';

/**
 * 5xx del HttpApi: >= 5 en 5 min. Un 5xx suelto puede ser un reintento o un fallo transitorio de
 * una dependencia (la alarma de errores de Lambda ya avisa de cada excepción); 5 en 5 minutos indica
 * un problema sostenido sin generar ruido con tráfico bajo.
 */
export const API_5XX_THRESHOLD = 5;

/**
 * Duración de QuotesCreate: el timeout es 10 s y el peor caso documentado de `POST /quotes` es
 * 9.5 s (`quotes-create/budget.ts`). Más de 8 s (máximo en 5 min) avisa ANTES de llegar al timeout.
 */
export const QUOTES_CREATE_DURATION_THRESHOLD_MS = 8000;

/**
 * 429 (`rate_limited`): >= 20 en 15 min. Una prueba manual del dueño (unos pocos intentos) no debe
 * disparar la alarma; una ráfaga sostenida de 20 rechazos en 15 min sí indica abuso o un bot.
 */
export const RATE_LIMITED_THRESHOLD = 20;
export const RATE_LIMITED_WINDOW_MINUTES = 15;

/** Montos mensuales (USD) de los presupuestos: aviso temprano y tope. */
export const BUDGET_LIMITS_USD = [5, 10] as const;

/** Lambdas públicas (sin authorizer): son las que importa vigilar por throttling. */
const PUBLIC_FUNCTIONS = ['QuotesCreate', 'FreightEstimate'] as const;

const EMAIL_RE = /^[^\s@,;]{1,64}@[^\s@,;]{1,255}\.[^\s@,;.]{2,}$/;

/**
 * Valida `ALERT_EMAIL`. Devuelve `undefined` si está vacío; lanza si el formato no es de un único
 * correo. No se inventa ni se guarda ningún correo por defecto.
 */
export function parseAlertEmail(raw: string | undefined): string | undefined {
  const value = (raw ?? '').trim();
  if (value === '') return undefined;
  if (!EMAIL_RE.test(value)) {
    throw new Error(`${ALERT_EMAIL_ENV} no es un correo válido (se espera un solo correo).`);
  }
  return value;
}

export interface ObservabilityStackProps extends StackProps {
  deploy: DeployEnv;
  httpApi: HttpApi;
  /** Lambdas de la API por nombre lógico (`ApiStack.observedFunctions`). */
  functions: Record<string, IFunction>;
  /** Grupo de logs de `QuotesCreate` (se reutiliza, no se duplica). */
  quotesCreateLogGroup: ILogGroup;
  /** Correo ya validado con `parseAlertEmail`. */
  alertEmail?: string;
}

export class ObservabilityStack extends Stack {
  public readonly alertsTopic: Topic;

  public constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    const { deploy, httpApi, functions, quotesCreateLogGroup } = props;
    super(scope, id, props);

    const alertEmail = parseAlertEmail(props.alertEmail);
    if (alertEmail === undefined && !deploy.emulated) {
      throw new Error(
        `Falta ${ALERT_EMAIL_ENV}: las alarmas sin destinatario no sirven. ` +
          `Ejemplo: ${ALERT_EMAIL_ENV}=correo@dominio.com npx cdk deploy ${id}`,
      );
    }

    // Tema SNS SIN cifrado: un tema cifrado con la clave administrada `alias/aws/sns` NO deja que
    // CloudWatch Alarms publique (su política de clave no se puede editar); haría falta una CMK propia
    // con permiso para `cloudwatch.amazonaws.com`. Con tan poco volumen y sin PII en la alarma, se evita.
    // Fuente: https://docs.aws.amazon.com/sns/latest/dg/sns-key-management.html
    this.alertsTopic = new Topic(this, 'Alerts', {
      topicName: `canteras-${deploy.name}-alerts`,
      displayName: 'Canteras Naturales: alertas',
    });
    if (alertEmail !== undefined && !deploy.emulated) {
      this.alertsTopic.addSubscription(new EmailSubscription(alertEmail));
    }
    const action = new SnsAction(this.alertsTopic);

    const prefix = `canteras-${deploy.name}`;
    const five = Duration.minutes(5);

    const addAlarm = (
      alarmId: string,
      alarmName: string,
      metric: IMetric,
      threshold: number,
      operator: ComparisonOperator,
    ): IAlarm => {
      const alarm = new Alarm(this, alarmId, {
        alarmName,
        metric,
        threshold,
        evaluationPeriods: 1,
        comparisonOperator: operator,
        // Sin datos = sin problema (una Lambda sin invocaciones no publica métricas).
        treatMissingData: TreatMissingData.NOT_BREACHING,
      });
      alarm.addAlarmAction(action);
      alarm.addOkAction(action);
      return alarm;
    };
    const atLeast = ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD;

    // a. Errores de CADA Lambda de la API.
    for (const [name, fn] of Object.entries(functions)) {
      addAlarm(
        `${name}Errors`,
        `${prefix}-${name}-errors`,
        fn.metricErrors({ period: five, statistic: 'Sum' }),
        1,
        atLeast,
      );
    }

    // b. 5xx del HttpApi (dimensión ApiId).
    addAlarm(
      'Api5xx',
      `${prefix}-api-5xx`,
      httpApi.metricServerError({ period: five, statistic: 'Sum' }),
      API_5XX_THRESHOLD,
      atLeast,
    );

    // c. Throttles de las Lambdas públicas.
    for (const name of PUBLIC_FUNCTIONS) {
      const fn = functions[name];
      if (fn === undefined) throw new Error(`Falta la Lambda ${name} en las funciones observadas.`);
      addAlarm(
        `${name}Throttles`,
        `${prefix}-${name}-throttles`,
        fn.metricThrottles({ period: five, statistic: 'Sum' }),
        1,
        atLeast,
      );
    }

    // c2. Throttles de MediaVariants (si se pasa; vive en MediaStack). Con concurrencia reservada
    // opcional o el límite de la cuenta, un throttle significa que se están perdiendo/atrasando fotos.
    const mediaVariants = functions['MediaVariants'];
    if (mediaVariants !== undefined) {
      addAlarm(
        'MediaVariantsThrottles',
        `${prefix}-MediaVariants-throttles`,
        mediaVariants.metricThrottles({ period: five, statistic: 'Sum' }),
        1,
        atLeast,
      );
    }

    // d. Duración de QuotesCreate cerca del timeout.
    const quotesCreate = functions['QuotesCreate'];
    if (quotesCreate === undefined) throw new Error('Falta la Lambda QuotesCreate.');
    addAlarm(
      'QuotesCreateDuration',
      `${prefix}-QuotesCreate-duration`,
      quotesCreate.metricDuration({ period: five, statistic: 'Maximum' }),
      QUOTES_CREATE_DURATION_THRESHOLD_MS,
      ComparisonOperator.GREATER_THAN_THRESHOLD,
    );

    // e y f. Filtros de métrica sobre los logs de QuotesCreate (el LogGroup ya existe en ApiStack).
    const folioFilter = new MetricFilter(this, 'FolioExhaustedFilter', {
      logGroup: quotesCreateLogGroup,
      filterPattern: FilterPattern.literal(FOLIO_EXHAUSTED_FILTER),
      metricNamespace: LOG_METRIC_NAMESPACE,
      metricName: 'FolioExhausted',
      metricValue: '1',
    });
    addAlarm(
      'FolioExhausted',
      `${prefix}-folio-exhausted`,
      folioFilter.metric({ period: five, statistic: 'Sum' }),
      1,
      atLeast,
    );

    const rateFilter = new MetricFilter(this, 'RateLimitedFilter', {
      logGroup: quotesCreateLogGroup,
      filterPattern: FilterPattern.literal(RATE_LIMITED_FILTER),
      metricNamespace: LOG_METRIC_NAMESPACE,
      metricName: 'RateLimited',
      metricValue: '1',
    });
    addAlarm(
      'RateLimited',
      `${prefix}-rate-limited`,
      rateFilter.metric({
        period: Duration.minutes(RATE_LIMITED_WINDOW_MINUTES),
        statistic: 'Sum',
      }),
      RATE_LIMITED_THRESHOLD,
      atLeast,
    );

    // AWS Budgets: es un servicio GLOBAL de la cuenta (no pertenece a este stack ni a una región) y
    // los nombres son únicos por cuenta, por eso llevan el entorno. La cuenta real y estos
    // presupuestos son parte del hito de AWS real; el emulador no los soporta.
    // `GREATER_THAN` es el operador más cercano a ">=" que admite Budgets.
    if (alertEmail !== undefined && !deploy.emulated) {
      const subscribers = [{ subscriptionType: 'EMAIL', address: alertEmail }];
      const notify = (
        notificationType: 'ACTUAL' | 'FORECASTED',
        threshold: number,
      ): CfnBudget.NotificationWithSubscribersProperty => ({
        notification: {
          notificationType,
          comparisonOperator: 'GREATER_THAN',
          threshold,
          thresholdType: 'PERCENTAGE',
        },
        subscribers,
      });
      for (const usd of BUDGET_LIMITS_USD) {
        new CfnBudget(this, `Budget${usd}Usd`, {
          budget: {
            budgetName: `${prefix}-monthly-${usd}usd`,
            budgetType: 'COST',
            timeUnit: 'MONTHLY',
            budgetLimit: { amount: usd, unit: 'USD' },
          },
          notificationsWithSubscribers: [
            notify('ACTUAL', 80),
            notify('ACTUAL', 100),
            notify('FORECASTED', 100),
          ],
        });
      }
    }
  }
}

import { SendEmailCommand } from '@aws-sdk/client-sesv2';
import { PutCommand } from '@aws-sdk/lib-dynamodb';

/** Correo ya renderizado. Los encabezados (`from`, `to`, `subject`) deben ir en una sola línea. */
export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<{ messageId: string }>;
}

/** Lo mínimo que se usa de un cliente del SDK (se inyecta para probar sin AWS). */
export interface SdkClient {
  send(command: unknown): Promise<unknown>;
}

/** Amazon SES v2 (`SendEmail`, modo simple: texto + HTML, UTF-8, un solo destinatario). */
export class SesV2Mailer implements Mailer {
  constructor(private readonly client: SdkClient) {}

  async send(m: MailMessage): Promise<{ messageId: string }> {
    const out = (await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: m.from,
        Destination: { ToAddresses: [m.to] },
        Content: {
          Simple: {
            Subject: { Data: m.subject, Charset: 'UTF-8' },
            Body: {
              Text: { Data: m.text, Charset: 'UTF-8' },
              Html: { Data: m.html, Charset: 'UTF-8' },
            },
          },
        },
      }),
    )) as { MessageId?: string };
    // Sin id no hay confirmación de que SES lo aceptó: no se da por enviado.
    if (typeof out.MessageId !== 'string' || out.MessageId === '') {
      throw new Error('SES no devolvió MessageId.');
    }
    return { messageId: out.MessageId };
  }
}

const OUTBOX_TTL_SECONDS = 7 * 24 * 3600;

export interface OutboxOptions {
  now?: () => Date;
  newId?: () => string;
}

/**
 * SOLO para el emulador (dev): en lugar de enviar, guarda el correo renderizado en una tabla
 * DynamoDB `MailOutbox` que existe únicamente cuando el stack se sintetiza con emulador. Se eligió
 * una tabla porque ya hay cliente, IAM y salidas de CDK para DynamoDB (no hace falta bucket ni
 * SES, que Floci podría no soportar) y se revisa con un simple `scan`. El cuerpo y el destinatario
 * NUNCA se escriben en logs: solo viven en esa tabla de dev.
 */
export class OutboxMailer implements Mailer {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly client: SdkClient,
    private readonly table: string,
    options: OutboxOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  async send(m: MailMessage): Promise<{ messageId: string }> {
    const messageId = `outbox-${this.newId()}`;
    await this.client.send(
      new PutCommand({
        TableName: this.table,
        // `ttl` (epoch en segundos, 7 días): el TTL de la tabla aún no está activado (pendiente).
        Item: {
          messageId,
          createdAt: this.now().toISOString(),
          ttl: Math.floor(this.now().getTime() / 1000) + OUTBOX_TTL_SECONDS,
          ...m,
        },
      }),
    );
    return { messageId };
  }
}

export interface MailerDeps {
  /** Se llama solo si hace falta (no se crean clientes sin usar). */
  ses: () => SdkClient;
  doc: () => SdkClient;
}

/**
 * Elige el transporte por entorno: `MAIL_TRANSPORT=ses` (AWS real), `outbox` (emulador, requiere
 * `MAIL_OUTBOX_TABLE`) o ausente (`null`: la ruta de envío responde 409 `mail_not_configured`).
 */
export function createMailer(
  env: Record<string, string | undefined>,
  deps: MailerDeps,
): Mailer | null {
  const transport = env['MAIL_TRANSPORT'];
  if (transport === undefined || transport === '') return null;
  if (transport === 'ses') return new SesV2Mailer(deps.ses());
  if (transport === 'outbox') {
    const table = env['MAIL_OUTBOX_TABLE'];
    if (table === undefined || table === '') {
      throw new Error('Falta la variable de entorno MAIL_OUTBOX_TABLE.');
    }
    return new OutboxMailer(deps.doc(), table);
  }
  throw new Error(`MAIL_TRANSPORT no válido: "${transport}" (usa "ses" u "outbox").`);
}

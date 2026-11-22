import { SendEmailCommand } from '@aws-sdk/client-sesv2';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { createMailer, OutboxMailer, SesV2Mailer, type MailMessage } from '../mailer';

const msg: MailMessage = {
  from: '"Patio" <ventas@example.com>',
  to: 'cliente@example.com',
  subject: 'Tu cotización',
  text: 'Hola ñ',
  html: '<p>Hola ñ</p>',
};

type Input = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
function fakeClient(reply: unknown | (() => never)) {
  const sent: { name: string; input: Input }[] = [];
  return {
    sent,
    client: {
      async send(command: { constructor: { name: string }; input: Input }) {
        sent.push({ name: command.constructor.name, input: command.input });
        if (typeof reply === 'function') (reply as () => never)();
        return reply;
      },
    },
  };
}

describe('SesV2Mailer', () => {
  it('envía con SESv2 SendEmail (UTF-8, un solo destinatario) y devuelve el MessageId', async () => {
    const { sent, client } = fakeClient({ MessageId: 'ses-123' });
    const out = await new SesV2Mailer(client).send(msg);
    expect(out).toEqual({ messageId: 'ses-123' });
    expect(sent[0]?.name).toBe(SendEmailCommand.name);
    expect(sent[0]?.input).toEqual({
      FromEmailAddress: msg.from,
      Destination: { ToAddresses: [msg.to] },
      Content: {
        Simple: {
          Subject: { Data: msg.subject, Charset: 'UTF-8' },
          Body: {
            Text: { Data: msg.text, Charset: 'UTF-8' },
            Html: { Data: msg.html, Charset: 'UTF-8' },
          },
        },
      },
    });
  });

  it('sin MessageId en la respuesta lanza error (no se da por enviado)', async () => {
    const { client } = fakeClient({});
    await expect(new SesV2Mailer(client).send(msg)).rejects.toThrow();
  });

  it('propaga el error de SES', async () => {
    const { client } = fakeClient(() => {
      throw new Error('MessageRejected');
    });
    await expect(new SesV2Mailer(client).send(msg)).rejects.toThrow('MessageRejected');
  });
});

describe('OutboxMailer (solo emulador/dev)', () => {
  it('guarda el correo renderizado en la tabla outbox y devuelve un id', async () => {
    const { sent, client } = fakeClient({});
    const mailer = new OutboxMailer(client, 'T-outbox', {
      now: () => new Date('2026-11-19T12:00:00.000Z'),
      newId: () => 'abc',
    });
    const out = await mailer.send(msg);
    expect(out).toEqual({ messageId: 'outbox-abc' });
    expect(sent[0]?.name).toBe(PutCommand.name);
    expect(sent[0]?.input).toMatchObject({
      TableName: 'T-outbox',
      Item: { messageId: 'outbox-abc', createdAt: '2026-11-19T12:00:00.000Z', ...msg },
    });
  });

  it('el ítem lleva ttl (epoch en segundos) a 7 días, para cuando se active el TTL de la tabla', async () => {
    const { sent, client } = fakeClient({});
    await new OutboxMailer(client, 'T', {
      now: () => new Date('2026-11-19T12:00:00.000Z'),
      newId: () => 'a',
    }).send(msg);
    expect(sent[0]?.input['Item'].ttl).toBe(
      Math.floor(Date.parse('2026-11-19T12:00:00.000Z') / 1000) + 7 * 86400,
    );
  });

  it('NO escribe el correo en los logs (ni consola)', async () => {
    const spies = (['log', 'info', 'warn', 'error'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    try {
      await new OutboxMailer(fakeClient({}).client, 'T').send(msg);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe('createMailer (por entorno)', () => {
  const deps = {
    ses: () => fakeClient({ MessageId: 'x' }).client,
    doc: () => fakeClient({}).client,
  };

  it('MAIL_TRANSPORT=ses -> SesV2Mailer', () => {
    expect(createMailer({ MAIL_TRANSPORT: 'ses' }, deps)).toBeInstanceOf(SesV2Mailer);
  });
  it('MAIL_TRANSPORT=outbox -> OutboxMailer (requiere la tabla)', () => {
    expect(createMailer({ MAIL_TRANSPORT: 'outbox', MAIL_OUTBOX_TABLE: 'T' }, deps)).toBeInstanceOf(
      OutboxMailer,
    );
    expect(() => createMailer({ MAIL_TRANSPORT: 'outbox' }, deps)).toThrow(/MAIL_OUTBOX_TABLE/);
  });
  it('sin transporte -> null (la ruta responde mail_not_configured)', () => {
    expect(createMailer({}, deps)).toBeNull();
    expect(createMailer({ MAIL_TRANSPORT: '' }, deps)).toBeNull();
  });
  it('un transporte desconocido falla al arrancar', () => {
    expect(() => createMailer({ MAIL_TRANSPORT: 'smtp' }, deps)).toThrow(/MAIL_TRANSPORT/);
  });
  it('no crea clientes que no usa', () => {
    let creados = 0;
    createMailer(
      {},
      {
        ses: () => (creados++, fakeClient({}).client),
        doc: () => (creados++, fakeClient({}).client),
      },
    );
    expect(creados).toBe(0);
  });
});

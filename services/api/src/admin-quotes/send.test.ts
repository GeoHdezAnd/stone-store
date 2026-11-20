/* eslint-disable @typescript-eslint/no-explicit-any -- respuestas JSON de prueba sin tipar */
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import type { Mailer, MailMessage } from '../lib/mailer';
import { ID_A, ID_B, MAIL_ROW, PUBLIC_ROW, quote, quotedQuote } from './fixtures';
import { MemoryQuoteRepository } from './memory-repository';
import { createQuotesRouter } from './routes';

type Ev = APIGatewayProxyEventV2WithJWTAuthorizer;

class FakeMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  fail: Error | null = null;
  /** Retraso para abrir la ventana de carrera entre el claim y el envío. */
  delayMs = 0;
  constructor(private readonly events: string[]) {}
  async send(m: MailMessage) {
    this.events.push('mail');
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.fail) throw this.fail;
    this.sent.push(m);
    return { messageId: 'msg-123' };
  }
}

function ev(path: string, body: unknown, groups: string, method = 'POST'): Ev {
  return {
    version: '2.0',
    rawPath: path,
    rawQueryString: '',
    headers: {},
    isBase64Encoded: false,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    requestContext: {
      requestId: 'req-1',
      http: { method, path },
      authorizer: {
        jwt: {
          claims: { sub: 'user-1', token_use: 'access', 'cognito:groups': groups },
          scopes: [],
        },
      },
    },
  } as unknown as Ev;
}

const T = Date.parse('2026-11-19T12:00:00.000Z');
const MIN = 60_000;

function setup(opts: { mailer?: 'none' } = {}) {
  const repo = new MemoryQuoteRepository();
  repo.settings.set('PUBLIC', structuredClone(PUBLIC_ROW));
  repo.settings.set('MAIL', structuredClone(MAIL_ROW));
  const mailer = new FakeMailer(repo.calls);
  const lines: string[] = [];
  const clock = { ms: T };
  const router = createQuotesRouter(
    { repo, mailer: opts.mailer === 'none' ? null : mailer, now: () => new Date(clock.ms) },
    { logSink: (l) => lines.push(l) },
  );
  const send = async (id: string, body: unknown = { rev: 1 }, groups = '[owner]') => {
    const res = await router.handle(ev(`/admin/quotes/${id}/send`, body, groups));
    const text = res.body as string;
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.statusCode, text, json };
  };
  const patch = async (id: string, body: unknown, groups = '[owner]') => {
    const res = await router.handle(ev(`/admin/quotes/${id}`, body, groups, 'PATCH'));
    return { status: res.statusCode, json: JSON.parse(res.body as string) };
  };
  const note = async (id: string, body: unknown, groups = '[owner]') => {
    const res = await router.handle(ev(`/admin/quotes/${id}/notes`, body, groups));
    return { status: res.statusCode, json: JSON.parse(res.body as string) };
  };
  return { repo, mailer, lines, send, clock, patch, note };
}

describe('POST /admin/quotes/{quoteId}/send', () => {
  it('flujo feliz: arma, envía y DESPUÉS guarda enviada, enviadaAt, respondedAt, historial y auditoría', async () => {
    const { repo, mailer, send } = setup();
    repo.seed(quotedQuote());
    const r = await send(ID_A);
    expect(r.status).toBe(200);
    expect(r.json.status).toBe('enviada');
    // rev 1 -> 2 (reclamo del envío) -> 3 (envío guardado): el cliente recibe el rev final.
    expect(r.json.rev).toBe(3);
    expect(r.json.sendLock).toBeUndefined();
    expect(r.json.finalQuote.enviadaAt).toBe('2026-11-19T12:00:00.000Z');
    expect(r.json.respondedAt).toBe('2026-11-19T12:00:00.000Z');
    expect(r.json.history).toEqual([
      {
        at: '2026-11-19T12:00:00.000Z',
        by: 'user-1',
        tipo: 'correo',
        texto: 'Cotización enviada a m***@example.com',
      },
      {
        at: '2026-11-19T12:00:00.000Z',
        by: 'user-1',
        tipo: 'estado',
        de: 'cotizada',
        a: 'enviada',
      },
    ]);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]).toMatchObject({
      to: 'maria@example.com',
      subject: 'Tu cotización CN-2026-00001 de Canteras Naturales',
    });
    expect(mailer.sent[0]!.text).toContain('Total: $3,605.00 MXN (sin IVA)');
    // El correo sale ANTES de la escritura.
    expect(repo.calls.filter((c) => c === 'mail' || c === 'update')).toEqual([
      'update',
      'mail',
      'update',
    ]);
    expect(repo.rows.get(ID_A)!['gsi1pk']).toBe('STATUS#enviada');
    expect(repo.audits).toHaveLength(1); // solo la del envío (el reclamo no audita)
    expect(repo.audits[0]).toMatchObject({ accion: 'send', pk: `ENTITY#quote#${ID_A}` });
  });

  it('respondedAt solo se fija si no existía', async () => {
    const { repo, send } = setup();
    repo.seed(quotedQuote({ respondedAt: '2026-11-15T09:00:00.000Z' }));
    const r = await send(ID_A);
    expect(r.json.respondedAt).toBe('2026-11-15T09:00:00.000Z');
  });

  it('solo owner: staff recibe 403 sin tocar el repositorio ni el mailer', async () => {
    const { repo, mailer, send } = setup();
    repo.seed(quotedQuote());
    const r = await send(ID_A, { rev: 1 }, '[staff]');
    expect(r.status).toBe(403);
    expect(mailer.sent).toHaveLength(0);
    expect(repo.calls).toEqual([]);
  });

  it('id que no es ULID: 400; inexistente: 404; sin rev o con campos extra: 422', async () => {
    const { repo, send } = setup();
    repo.seed(quotedQuote());
    expect((await send('no-es-ulid')).status).toBe(400);
    expect((await send(ID_B)).status).toBe(404);
    expect((await send(ID_A, {})).status).toBe(422);
    expect((await send(ID_A, { rev: 1, to: 'otro@example.com' })).status).toBe(422);
    expect((await send(ID_A, 'x')).status).toBe(422);
  });

  it.each(['nueva', 'en_revision', 'enviada', 'ganada', 'perdida', 'cancelada'] as const)(
    'estado %s: 409 invalid_transition y no se envía nada',
    async (status) => {
      const { repo, mailer, send } = setup();
      repo.seed(quotedQuote({ status }));
      const r = await send(ID_A);
      expect(r.status).toBe(409);
      expect(r.json.error).toBe('invalid_transition');
      expect(mailer.sent).toHaveLength(0);
      expect(repo.audits).toHaveLength(0);
    },
  );

  it('doble envío: el segundo es 409 invalid_transition y solo sale un correo', async () => {
    const { repo, mailer, send } = setup();
    repo.seed(quotedQuote());
    expect((await send(ID_A)).status).toBe(200);
    const again = await send(ID_A, { rev: 3 });
    expect(again.status).toBe(409);
    expect(again.json.error).toBe('invalid_transition');
    expect(mailer.sent).toHaveLength(1);
  });

  it('finalQuote ausente o incompleto: 422 final_quote_incomplete', async () => {
    const a = setup();
    a.repo.seed(quote({ status: 'cotizada' }));
    const r1 = await a.send(ID_A);
    expect(r1.status).toBe(422);
    expect(r1.json.error).toBe('final_quote_incomplete');
    const b = setup();
    const q = quotedQuote();
    b.repo.seed({ ...q, finalQuote: { ...q.finalQuote!, items: [q.finalQuote!.items[0]!] } });
    expect((await b.send(ID_A)).json.error).toBe('final_quote_incomplete');
    expect(a.mailer.sent.length + b.mailer.sent.length).toBe(0);
  });

  it('rev viejo: 409 conflict antes de enviar', async () => {
    const { repo, mailer, send } = setup();
    repo.seed(quotedQuote({ rev: 3 }));
    const r = await send(ID_A, { rev: 1 });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('conflict');
    expect(mailer.sent).toHaveLength(0);
  });

  it('sin transporte de correo: 409 mail_not_configured', async () => {
    const { repo, send } = setup({ mailer: 'none' });
    repo.seed(quotedQuote());
    const r = await send(ID_A);
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('mail_not_configured');
    expect(repo.audits).toHaveLength(0);
  });

  it.each(['PUBLIC', 'MAIL'] as const)(
    'falta la configuración %s: 409 settings_missing',
    async (key) => {
      const { repo, mailer, send } = setup();
      repo.seed(quotedQuote());
      repo.settings.delete(key);
      const r = await send(ID_A);
      expect(r.status).toBe(409);
      expect(r.json.error).toBe('settings_missing');
      expect(mailer.sent).toHaveLength(0);
    },
  );

  it('plantilla con variable desconocida o fila corrupta: 409 settings_invalid, sin enviar', async () => {
    const { repo, mailer, send } = setup();
    repo.seed(quotedQuote());
    repo.settings.set('MAIL', { ...MAIL_ROW, plantillaCotizacion: 'Hola {{notas}}' });
    const r = await send(ID_A);
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('settings_invalid');
    expect(mailer.sent).toHaveLength(0);
  });

  it('falla SES: 502 send_failed, se libera el candado y no queda nada en historial ni auditoría', async () => {
    const { repo, mailer, lines, send } = setup();
    repo.seed(quotedQuote());
    mailer.fail = new Error('MessageRejected para maria@example.com');
    const r = await send(ID_A);
    expect(r.status).toBe(502);
    expect(r.json.error).toBe('send_failed');
    expect(r.text).not.toContain('maria@example.com');
    expect(repo.audits).toHaveLength(0);
    const row = repo.rows.get(ID_A)!;
    expect(row['status']).toBe('cotizada');
    expect(row['sendLock']).toBeUndefined();
    expect(row['history']).toEqual([]);
    expect(row['respondedAt']).toBeUndefined();
    expect(row['rev']).toBe(3); // reclamo (2) + liberación (3): el rev sube aunque no cambie nada más
    expect(lines.join('\n')).toContain('send_failed');
    expect(lines.join('\n')).not.toContain('maria@example.com');
  });

  it('tras un fallo de SES el reintento (con el rev nuevo) sí envía', async () => {
    const { repo, mailer, send } = setup();
    repo.seed(quotedQuote());
    mailer.fail = new Error('boom');
    expect((await send(ID_A)).status).toBe(502);
    mailer.fail = null;
    expect((await send(ID_A, { rev: 3 })).status).toBe(200);
    expect(mailer.sent).toHaveLength(1);
  });

  it('conflicto de rev DESPUÉS del envío: 409 conflict_after_send (el correo sí salió), con messageId en logs', async () => {
    const { repo, mailer, lines, send } = setup();
    repo.seed(quotedQuote());
    // Escritura 1 = reclamo; la 2 = guardado final, justo antes de ella alguien cambia la solicitud.
    repo.onBeforeWrite = (n) => {
      if (n === 2) repo.rows.get(ID_A)!['rev'] = 99;
    };
    const r = await send(ID_A);
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('conflict_after_send');
    expect(r.json.message).toMatch(/sí salió/);
    expect(mailer.sent).toHaveLength(1);
    expect(repo.audits).toHaveLength(0);
    const dump = lines.join('\n');
    expect(dump).toContain('conflict_after_send');
    expect(dump).toContain('msg-123');
    expect(dump).not.toContain('maria@example.com');
  });

  it('error inesperado al guardar tras enviar: 500 genérico y messageId en logs', async () => {
    const { repo, lines, send } = setup();
    repo.seed(quotedQuote());
    repo.writeError = new Error('boom maria@example.com');
    repo.writeErrorOn = 2; // falla el guardado final, no el reclamo
    const r = await send(ID_A);
    expect(r.status).toBe(500);
    expect(r.text).not.toContain('maria@example.com');
    expect(lines.join('\n')).toContain('msg-123');
    expect(lines.join('\n')).not.toContain('maria@example.com');
  });

  it('historial lleno o ítem demasiado grande: 409 ANTES de enviar', async () => {
    const a = setup();
    const h = { at: '2026-11-10T10:00:00.000Z', by: 'u', tipo: 'nota' as const };
    a.repo.seed(quotedQuote({ history: Array(199).fill(h) }));
    expect((await a.send(ID_A)).json.error).toBe('history_full');
    expect(a.repo.calls).not.toContain('update'); // ni siquiera se reclama
    const b = setup();
    const n = { at: '2026-11-10T10:00:00.000Z', by: 'u', texto: '漢'.repeat(2000) };
    b.repo.seed(quotedQuote({ notes: Array(58).fill(n) }));
    expect((await b.send(ID_A)).json.error).toBe('quote_too_large');
    expect(a.mailer.sent.length + b.mailer.sent.length).toBe(0);
  });

  it('asunto con saltos de línea y XSS en el nombre: cabeceras en una línea y HTML escapado', async () => {
    const { repo, mailer, send } = setup();
    repo.seed(
      quotedQuote({
        customer: {
          nombre: '<script>alert(1)</script>\r\nBcc: x@evil.com',
          telefono: '555-0101',
          correo: 'maria@example.com',
        },
      }),
    );
    repo.settings.set('MAIL', { ...MAIL_ROW, asuntoCotizacion: 'Hola {{nombre}}' });
    expect((await send(ID_A)).status).toBe(200);
    const m = mailer.sent[0]!;
    for (const h of [m.subject, m.from, m.to]) expect(h).not.toMatch(/[\r\n]/);
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('&lt;script&gt;');
  });

  it('las notas internas y el historial nunca llegan al correo', async () => {
    const { repo, mailer, send } = setup();
    repo.seed(
      quotedQuote({
        notes: [{ at: '2026-11-10T10:00:00.000Z', by: 'u', texto: 'SECRETO-NOTA' }],
        history: [{ at: '2026-11-10T10:00:00.000Z', by: 'u', tipo: 'nota', texto: 'SECRETO-HIST' }],
      }),
    );
    await send(ID_A);
    const m = mailer.sent[0]!;
    for (const s of [m.subject, m.text, m.html]) expect(s).not.toContain('SECRETO');
  });

  it('PII fuera de auditoría, historial y logs: el correo completo y el teléfono no aparecen', async () => {
    const { repo, lines, send } = setup();
    repo.seed(quotedQuote());
    const r = await send(ID_A);
    const dump = JSON.stringify(repo.audits) + JSON.stringify(r.json.history) + lines.join('\n');
    for (const pii of ['maria@example.com', '555-0101', 'María', 'Pérez', 'San Andrés']) {
      expect(dump).not.toContain(pii);
    }
    expect(lines.join('\n')).toContain('quote_sent');
    expect(lines.join('\n')).toContain('msg-123');
    expect(repo.audits[0]).toMatchObject({
      antes: { status: 'cotizada', rev: 1 },
      despues: { status: 'enviada', rev: 3 },
    });
  });
});

describe('candado de envío (carreras)', () => {
  const lockAt = (ms: number) => ({ at: new Date(ms).toISOString(), by: 'otro-usuario' });

  it('2 envíos simultáneos con mailer lento: exactamente UN correo', async () => {
    const { repo, mailer, send } = setup();
    repo.seed(quotedQuote());
    mailer.delayMs = 20;
    const res = await Promise.all([send(ID_A), send(ID_A)]);
    expect(mailer.sent).toHaveLength(1);
    expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(res.find((r) => r.status === 409)!.json.error).toBe('send_in_progress');
    expect(repo.audits).toHaveLength(1);
  });

  it('5 envíos simultáneos: exactamente UN correo y cuatro send_in_progress', async () => {
    const { repo, mailer, send } = setup();
    repo.seed(quotedQuote());
    mailer.delayMs = 20;
    const res = await Promise.all([1, 2, 3, 4, 5].map(() => send(ID_A)));
    expect(mailer.sent).toHaveLength(1);
    expect(res.filter((r) => r.status === 200)).toHaveLength(1);
    expect(res.filter((r) => r.json.error === 'send_in_progress')).toHaveLength(4);
  });

  it('el reclamo pierde la carrera ANTES de enviar: no sale ningún correo para el perdedor', async () => {
    const { repo, mailer, send } = setup();
    repo.seed(quotedQuote());
    // Otro proceso reclama justo antes de nuestra escritura de reclamo.
    repo.onBeforeWrite = (n) => {
      if (n === 1) repo.rows.get(ID_A)!['rev'] = 2;
    };
    const r = await send(ID_A);
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('send_in_progress');
    expect(mailer.sent).toHaveLength(0);
  });

  it('candado vigente: bloquea envío, PATCH y notas con 409 send_in_progress y no toca nada', async () => {
    const { repo, mailer, send, patch, note } = setup();
    repo.seed(quotedQuote({ sendLock: lockAt(T - 60_000) }));
    const before = structuredClone(repo.rows.get(ID_A));
    for (const r of [
      await send(ID_A),
      await patch(ID_A, { status: 'en_revision', rev: 1 }),
      await note(ID_A, { texto: 'hola', rev: 1 }),
    ]) {
      expect(r.status).toBe(409);
      expect(r.json.error).toBe('send_in_progress');
    }
    expect(mailer.sent).toHaveLength(0);
    expect(repo.rows.get(ID_A)).toEqual(before);
    expect(repo.calls.filter((c) => c === 'update')).toEqual([]);
  });

  it('candado vencido (> 5 min): se puede reintentar el envío', async () => {
    const { repo, mailer, send } = setup();
    repo.seed(quotedQuote({ sendLock: lockAt(T - 6 * MIN) }));
    const r = await send(ID_A);
    expect(r.status).toBe(200);
    expect(mailer.sent).toHaveLength(1);
    expect(r.json.sendLock).toBeUndefined();
  });

  it('candado vencido: PATCH y notas funcionan y lo limpian', async () => {
    const { repo, patch, note } = setup();
    repo.seed(quotedQuote({ sendLock: lockAt(T - 6 * MIN) }));
    const p = await patch(ID_A, { status: 'en_revision', rev: 1 });
    expect(p.status).toBe(200);
    expect(p.json.sendLock).toBeUndefined();
    repo.seed(quotedQuote({ sendLock: lockAt(T - 6 * MIN) }));
    const n = await note(ID_A, { texto: 'hola', rev: 1 });
    expect(n.status).toBe(201);
    expect(n.json.sendLock).toBeUndefined();
  });

  it('proceso caído tras el reclamo (SES falla y la liberación también): bloquea 5 min y luego se reintenta', async () => {
    const { repo, mailer, clock, send } = setup();
    repo.seed(quotedQuote());
    mailer.fail = new Error('boom');
    repo.writeError = new Error('dynamo caído');
    repo.writeErrorOn = 2; // el reclamo (1) pasa; la liberación (2) falla
    const r1 = await send(ID_A);
    expect(r1.status).toBe(502);
    expect(repo.rows.get(ID_A)!['sendLock']).toBeDefined(); // el candado queda
    repo.writeError = null;
    mailer.fail = null;
    // Mientras está vigente nadie puede reintentar (el rev ya es 2).
    expect((await send(ID_A, { rev: 2 })).json.error).toBe('send_in_progress');
    expect(mailer.sent).toHaveLength(0);
    clock.ms += 6 * MIN;
    expect((await send(ID_A, { rev: 2 })).status).toBe(200);
    expect(mailer.sent).toHaveLength(1);
  });

  it('el cuerpo del envío no admite fijar el candado', async () => {
    const { repo, send } = setup();
    repo.seed(quotedQuote());
    expect((await send(ID_A, { rev: 1, sendLock: lockAt(T) })).status).toBe(422);
  });
});

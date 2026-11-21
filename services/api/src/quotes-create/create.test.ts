import { generateUlid, quoteSchema, stripStorageKeys } from '@canteras/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mailer, MailMessage } from '../lib/mailer';
import {
  FakeCaptchaVerifier,
  TurnstileVerifier,
  type CaptchaVerifier,
  type FetchLike,
} from './captcha';
import { createQuotesCreateHandler, MAX_BODY_BYTES, type QuotesCreateDeps } from './create';
import { event, NOW, seedRepo, SENTINEL, validBody, type EventOptions } from './fixtures';
import { MemoryQuotesCreateRepository } from './memory-repository';
import { DuplicateQuoteError } from './repository';

afterEach(() => vi.useRealTimers());

function setup(over: Partial<QuotesCreateDeps> = {}) {
  const repo = new MemoryQuotesCreateRepository();
  seedRepo(repo);
  const sent: MailMessage[] = [];
  const mailer: Mailer = {
    send: async (m) => {
      sent.push(structuredClone(m));
      return { messageId: 'm1' };
    },
  };
  const logs: string[] = [];
  const verifyCalls: { token: string; remoteIp?: string | undefined }[] = [];
  const captcha: CaptchaVerifier = {
    verify: async (i) => {
      verifyCalls.push(i);
      return new FakeCaptchaVerifier().verify(i);
    },
  };
  let n = 0;
  const handler = createQuotesCreateHandler({
    repo,
    captcha,
    mailer,
    adminBaseUrl: 'https://admin.ejemplo.mx',
    now: () => NOW,
    newQuoteId: () => generateUlid(NOW.getTime() + n++, () => 0.1),
    random: () => 0.5,
    logSink: (l) => logs.push(l),
    ...over,
  });
  const call = (body: unknown, opts?: EventOptions) => handler.handle(event(body, opts));
  return { repo, sent, logs, verifyCalls, call, handler };
}

const json = (res: { body?: string | undefined }): Record<string, unknown> =>
  JSON.parse(res.body as string) as Record<string, unknown>;

const storedQuote = (repo: MemoryQuotesCreateRepository) => [...repo.quotes.values()][0]!;

describe('éxito', () => {
  it('201 con el folio, y nada más en la respuesta', async () => {
    const { call } = setup();
    const res = await call(validBody());
    expect(res.statusCode).toBe(201);
    expect(json(res)).toEqual({ folio: 'CN-2026-00001' });
    expect(res.headers).toMatchObject({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
  });

  it('guarda UN documento `nueva` válido contra quoteSchema, con claves de índice', async () => {
    const { call, repo } = setup();
    await call(validBody());
    expect(repo.quotes.size).toBe(1);
    const item = storedQuote(repo);
    const parsed = quoteSchema.safeParse(stripStorageKeys(item));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(item).toMatchObject({
      folio: 'CN-2026-00001',
      status: 'nueva',
      rev: 1,
      history: [],
      notes: [],
      createdAt: NOW.toISOString(),
      consentAt: NOW.toISOString(),
      gsi1pk: 'STATUS#nueva',
      gsi2pk: 'QUOTE',
    });
    expect(item['gsi1sk']).toBe(`${NOW.toISOString()}#${item['quoteId']}`);
    expect(typeof item['searchKey']).toBe('string');
    expect(item).not.toHaveProperty('freight');
    expect(item).not.toHaveProperty('finalQuote');
  });

  it('el peso y el nombre de cada piedra los calcula el servidor (merma de la tarifa activa)', async () => {
    const { call, repo } = setup();
    await call(validBody());
    expect(storedQuote(repo)['items']).toEqual([
      {
        stoneId: 'arenisca',
        nombre: 'Arenisca',
        acabado: 'Labrado',
        cantidad: 10,
        unidad: 'm2',
        pesoKg: 1155, // 2200 × 0.05 × 10 × 1.05
      },
      {
        stoneId: 'caliza',
        nombre: 'Caliza',
        acabado: '',
        cantidad: 2,
        unidad: 'tonelada',
        pesoKg: 2100,
      },
    ]);
  });

  it('con otra merma activa cambia el peso', async () => {
    const { call, repo } = setup();
    repo.activeFreight = { ...repo.activeFreight, mermaPct: 0 };
    await call(validBody());
    expect((storedQuote(repo)['items'] as { pesoKg: number }[])[0]!.pesoKg).toBe(1100);
  });

  it('source: userAgent y referrer sin query', async () => {
    const { call, repo } = setup();
    await call(validBody());
    expect(storedQuote(repo)['source']).toEqual({
      userAgent: 'Mozilla/5.0 (pruebas)',
      referrer: 'https://sitio.ejemplo.mx/contacto',
    });
  });

  it('los folios son consecutivos y el contador es el del año de `now` en UTC', async () => {
    const { call, repo } = setup();
    expect(json(await call(validBody())).folio).toBe('CN-2026-00001');
    expect(json(await call(validBody())).folio).toBe('CN-2026-00002');
    expect(repo.counters.get(2026)).toBe(2);
    expect(repo.quotes.size).toBe(2);
  });

  it('año nuevo en UTC: el folio usa el año de createdAt', async () => {
    const { call, repo } = setup({ now: () => new Date('2027-01-01T00:00:01.000Z') });
    expect(json(await call(validBody())).folio).toBe('CN-2027-00001');
    expect(repo.counters.get(2027)).toBe(1);
    expect(repo.counters.has(2026)).toBe(false);
  });

  it('orden fijo: tarifa, piedras, folio, guardar, y solo después Settings y correos', async () => {
    const { call, repo } = setup();
    await call(validBody());
    expect(repo.calls).toEqual([
      'getActiveFreightRow',
      'getStones',
      'reserveFolioNumber',
      'putQuote',
      'getPublicSettings',
    ]);
  });

  it('pide solo las piedras de la solicitud', async () => {
    const { call, repo } = setup();
    const spy = vi.spyOn(repo, 'getStones');
    await call(validBody());
    expect(spy).toHaveBeenCalledWith(['arenisca', 'caliza']);
  });

  it('un acabado vacío o ausente es válido', async () => {
    const { call, repo } = setup();
    const res = await call(
      validBody({ items: [{ stoneId: 'caliza', acabado: '', cantidad: 1, unidad: 'tonelada' }] }),
    );
    expect(res.statusCode).toBe(201);
    expect(repo.quotes.size).toBe(1);
  });
});

describe('correos', () => {
  it('manda confirmación al cliente y aviso al dueño, con remitente de Settings', async () => {
    const { call, sent, repo } = setup();
    await call(validBody());
    expect(sent).toHaveLength(2);
    const [cliente, dueno] = [
      sent.find((m) => m.to === SENTINEL.correo)!,
      sent.find((m) => m.to === 'ventas@example.com')!,
    ];
    expect(cliente).toBeDefined();
    expect(dueno).toBeDefined();
    for (const m of sent)
      expect(m.from).toBe('"Canteras Naturales (ejemplo)" <ventas@example.com>');
    expect(cliente.subject).toBe('Recibimos tu solicitud de cotización CN-2026-00001');
    expect(cliente.text).toContain('menos de 48 horas');
    expect(dueno.subject).toBe(`Nueva solicitud CN-2026-00001: ${SENTINEL.nombre}`);
    const id = storedQuote(repo)['quoteId'];
    expect(dueno.text).toContain(`https://admin.ejemplo.mx/quotes/${id}`);
    expect(dueno.text).toContain(SENTINEL.telefono);
  });

  it('sin adminBaseUrl el aviso va sin enlace', async () => {
    const { call, sent } = setup({ adminBaseUrl: undefined });
    await call(validBody());
    const dueno = sent.find((m) => m.to === 'ventas@example.com')!;
    expect(dueno.text).not.toMatch(/https?:\/\//);
  });

  it('el HTML escapa los datos del cliente y el asunto no admite saltos de línea', async () => {
    const { call, sent } = setup();
    await call(
      validBody({
        customer: {
          nombre: '<script>alert(1)</script>',
          telefono: '2225550148',
          correo: 'a@cliente-ejemplo.mx',
        },
        works: { lugar: '<img src=x onerror=1>', codigoPostal: '72810', uso: '', notas: 'a\nb' },
      }),
    );
    for (const m of sent) {
      expect(m.html).not.toMatch(/<script|<img/);
      expect(m.subject).not.toMatch(/[\r\n]/);
    }
  });

  describe('best-effort: nada de esto rompe el 201', () => {
    const casos: [string, (s: ReturnType<typeof setup>) => void, Partial<QuotesCreateDeps>?][] = [
      [
        'el transporte falla en los dos correos',
        () => undefined,
        {
          mailer: {
            send: async () => {
              throw new Error(`SES rechazó ${SENTINEL.correo}`);
            },
          },
        },
      ],
      [
        'no hay fila PUBLIC de Settings',
        (s) => {
          s.repo.publicSettings = null;
        },
      ],
      [
        'Settings inválida',
        (s) => {
          s.repo.publicSettings = { key: 'PUBLIC', basura: 1 };
        },
      ],
      [
        'leer Settings lanza',
        (s) => {
          s.repo.failOn.set('getPublicSettings', new Error('boom'));
        },
      ],
      ['no hay transporte de correo', () => undefined, { mailer: null }],
    ];
    it.each(casos)('%s', async (_n, prepare, over) => {
      const s = setup(over);
      prepare(s);
      const res = await s.call(validBody());
      expect(res.statusCode).toBe(201);
      expect(json(res)).toEqual({ folio: 'CN-2026-00001' });
      expect(s.repo.quotes.size).toBe(1);
      // El fallo se registra, sin PII.
      expect(s.logs.some((l) => /"level":"(warn|error)"/.test(l))).toBe(true);
      const todo = s.logs.join('\n');
      for (const v of [SENTINEL.correo, SENTINEL.nombre, SENTINEL.telefono])
        expect(todo).not.toContain(v);
    });

    it('si falla solo el primer correo, el otro se manda igual', async () => {
      let calls = 0;
      const sent: MailMessage[] = [];
      const s = setup({
        mailer: {
          send: async (m) => {
            calls++;
            if (calls === 1) throw new Error('fallo');
            sent.push(m);
            return { messageId: 'x' };
          },
        },
      });
      const res = await s.call(validBody());
      expect(res.statusCode).toBe(201);
      expect(calls).toBe(2);
      expect(sent).toHaveLength(1);
    });
  });
});

describe('tamaño y formato del cuerpo', () => {
  it('el tope es de 16 KB', () => {
    expect(MAX_BODY_BYTES).toBe(16 * 1024);
  });

  it('un cuerpo de exactamente 16 KB se acepta y uno de 16 KB + 1 byte da 413 sin tocar nada', async () => {
    const s = setup();
    const base = JSON.stringify(validBody());
    const justo = base + ' '.repeat(MAX_BODY_BYTES - Buffer.byteLength(base));
    expect(Buffer.byteLength(justo)).toBe(MAX_BODY_BYTES);
    expect((await s.call(justo)).statusCode).toBe(201);

    const s2 = setup();
    const res = await s2.call(justo + ' ');
    expect(res.statusCode).toBe(413);
    expect(json(res)).toEqual({ error: 'payload_too_large' });
    expect(s2.repo.calls).toEqual([]);
    expect(s2.verifyCalls).toEqual([]);
  });

  it('mide BYTES, no caracteres (8200 «ñ» son 16 400 bytes)', async () => {
    const s = setup();
    const res = await s.call(JSON.stringify({ x: 'ñ'.repeat(8200) }));
    expect(res.statusCode).toBe(413);
  });

  it('413 ANTES de parsear: un cuerpo enorme que ni es JSON también da 413', async () => {
    const res = await setup().call('{'.repeat(100_000));
    expect(res.statusCode).toBe(413);
  });

  it('base64: mide el tamaño decodificado', async () => {
    const big = Buffer.from(' '.repeat(MAX_BODY_BYTES + 1)).toString('base64');
    const res = await setup().call(big, { isBase64Encoded: true });
    expect(res.statusCode).toBe(413);
    const ok = Buffer.from(JSON.stringify(validBody())).toString('base64');
    expect((await setup().call(ok, { isBase64Encoded: true })).statusCode).toBe(201);
  });

  it.each(['no es json', '', '{"a":', '{"a":1}}'])(
    'JSON inválido (%j): 400 invalid_json',
    async (raw) => {
      const s = setup();
      const res = await s.call(raw);
      expect(res.statusCode).toBe(400);
      expect(json(res)).toEqual({ error: 'invalid_json' });
      expect(s.repo.calls).toEqual([]);
    },
  );

  it.each(['[]', 'null', '5', '"texto"', 'true'])(
    'JSON que no es un objeto (%s): 422',
    async (raw) => {
      const res = await setup().call(raw);
      expect(res.statusCode).toBe(422);
      expect(json(res).error).toBe('validation_error');
    },
  );

  it.each([
    [undefined],
    ['text/plain'],
    ['application/x-www-form-urlencoded'],
    ['application/jsonx'],
    ['multipart/form-data; boundary=x'],
  ])('Content-Type %s: 415', async (ct) => {
    const s = setup();
    const res = await s.call(validBody(), { headers: { 'content-type': ct } });
    expect(res.statusCode).toBe(415);
    expect(json(res)).toEqual({ error: 'unsupported_media_type' });
    expect(s.repo.calls).toEqual([]);
  });

  it.each(['application/json', 'application/json; charset=utf-8', 'APPLICATION/JSON'])(
    'Content-Type %s: aceptado',
    async (ct) => {
      expect(
        (await setup().call(validBody(), { headers: { 'content-type': ct } })).statusCode,
      ).toBe(201);
    },
  );

  it('acepta el nombre de cabecera con otra capitalización', async () => {
    const s = setup();
    const ev = event(validBody(), {
      headers: { 'content-type': undefined, 'Content-Type': 'application/json' },
    });
    expect((await s.handler.handle(ev)).statusCode).toBe(201);
  });

  it.each(['GET', 'PUT', 'DELETE', 'PATCH'])('método %s: 405', async (method) => {
    const res = await setup().call(validBody(), { method });
    expect(res.statusCode).toBe(405);
  });
});

describe('validación', () => {
  it('422 validation_error con issues {path,message} y SIN eco de lo enviado', async () => {
    const s = setup();
    const res = await s.call(
      validBody({
        customer: { nombre: '', telefono: SENTINEL.token, correo: SENTINEL.token },
        works: { lugar: SENTINEL.lugar, codigoPostal: SENTINEL.token, uso: '', notas: '' },
        consent: false,
      }),
    );
    expect(res.statusCode).toBe(422);
    const body = json(res);
    expect(body.error).toBe('validation_error');
    expect((body.issues as { path: string; message: string }[]).length).toBeGreaterThan(2);
    expect(res.body).not.toContain(SENTINEL.token);
    expect(res.body).not.toContain(SENTINEL.lugar);
    expect(s.repo.calls).toEqual([]);
    expect(s.verifyCalls).toEqual([]);
  });

  it.each(['pesoKg', 'nombre', 'precioUnitario', 'subtotal'])(
    'un campo extra `%s` en una piedra: 422 y no se guarda nada (el peso nunca viene del cliente)',
    async (campo) => {
      const s = setup();
      const res = await s.call(
        validBody({ items: [{ stoneId: 'caliza', cantidad: 1, unidad: 'tonelada', [campo]: 1 }] }),
      );
      expect(res.statusCode).toBe(422);
      expect(s.repo.quotes.size).toBe(0);
      expect(res.body).not.toContain(campo);
    },
  );

  it.each(['folio', 'status', 'rev', 'quoteId', 'freight', 'createdAt'])(
    'un campo de servidor `%s` en la raíz: 422',
    async (campo) => {
      const res = await setup().call(validBody({ [campo]: 'x' }));
      expect(res.statusCode).toBe(422);
    },
  );

  it('__proto__ como propiedad propia: 422 y sin contaminar el prototipo', async () => {
    const raw = JSON.stringify(validBody()).replace('{', '{"__proto__":{"polluted":true},');
    const res = await setup().call(raw);
    expect(res.statusCode).toBe(422);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('un honeypot lleno con el resto inválido sigue siendo 422 (la validación va primero)', async () => {
    const res = await setup().call(validBody({ website: 'http://spam', consent: false }));
    expect(res.statusCode).toBe(422);
  });
});

describe('honeypot', () => {
  it('lleno: misma respuesta que un éxito (201 {folio}), sin guardar, sin correos, sin consumir folio', async () => {
    const s = setup();
    const res = await s.call(validBody({ website: 'http://spam.example' }));
    const real = await setup().call(validBody());
    expect(res.statusCode).toBe(real.statusCode);
    expect(res.statusCode).toBe(201);
    expect(Object.keys(json(res))).toEqual(Object.keys(json(real)));
    expect(json(res).folio).toMatch(/^CN-2026-\d{5}$/);
    expect(s.repo.quotes.size).toBe(0);
    expect(s.repo.counters.size).toBe(0);
    expect(s.repo.calls).toEqual([]);
    expect(s.sent).toEqual([]);
    expect(s.verifyCalls).toEqual([]);
  });

  it('el folio señuelo es verosímil y el log solo dice que se detectó (sin PII)', async () => {
    const s = setup();
    await s.call(validBody({ website: 'x' }));
    const todo = s.logs.join('\n');
    expect(todo).toContain('honeypot_triggered');
    for (const v of [SENTINEL.correo, SENTINEL.nombre, SENTINEL.telefono])
      expect(todo).not.toContain(v);
  });

  it('un honeypot de solo espacios cuenta como vacío (autocompletado de navegador)', async () => {
    const s = setup();
    const res = await s.call(validBody({ website: '   ' }));
    expect(res.statusCode).toBe(201);
    expect(s.repo.quotes.size).toBe(1);
  });
});

describe('captcha: falla cerrado', () => {
  it('token falso: 403 captcha_failed y no se toca la base ni se manda correo', async () => {
    const s = setup();
    const res = await s.call(validBody({ turnstileToken: 'falso' }));
    expect(res.statusCode).toBe(403);
    expect(json(res)).toEqual({ error: 'captcha_failed' });
    expect(s.repo.calls).toEqual([]);
    expect(s.sent).toEqual([]);
  });

  it('el verificador lanza: 403', async () => {
    const s = setup({
      captcha: {
        verify: async () => {
          throw new Error('boom');
        },
      },
    });
    const res = await s.call(validBody());
    expect(res.statusCode).toBe(403);
    expect(s.repo.calls).toEqual([]);
  });

  it('el verificador devuelve algo que no es `true`: 403', async () => {
    for (const v of [false, undefined, null, 'true', 1]) {
      const s = setup({ captcha: { verify: async () => v as never } });
      expect((await s.call(validBody())).statusCode, String(v)).toBe(403);
    }
  });

  it('sin verificador configurado: 503 captcha_not_configured', async () => {
    const s = setup({ captcha: null });
    const res = await s.call(validBody());
    expect(res.statusCode).toBe(503);
    expect(json(res)).toEqual({ error: 'captcha_not_configured' });
    expect(s.repo.calls).toEqual([]);
  });

  it('pasa la IP de origen solo si el evento la trae', async () => {
    const s = setup();
    await s.call(validBody(), { sourceIp: '198.51.100.9' });
    expect(s.verifyCalls[0]).toEqual({ token: 'test-pass', remoteIp: '198.51.100.9' });
    const s2 = setup();
    await s2.call(validBody(), { sourceIp: null });
    expect(s2.verifyCalls[0]).toEqual({ token: 'test-pass' });
    expect('remoteIp' in s2.verifyCalls[0]!).toBe(false);
  });

  describe('con el verificador real de Turnstile', () => {
    const real = (fetch: FetchLike, secret: () => Promise<string> = async () => 's3cr3t') =>
      setup({ captcha: new TurnstileVerifier({ secret, fetch }) });

    it('success:true deja pasar', async () => {
      const s = real(async () => ({ ok: true, json: async () => ({ success: true }) }));
      expect((await s.call(validBody())).statusCode).toBe(201);
    });

    it.each([
      ['success:false', async () => ({ ok: true, json: async () => ({ success: false }) })],
      [
        'no es JSON',
        async () => ({
          ok: true,
          json: async () => {
            throw new SyntaxError('x');
          },
        }),
      ],
      ['HTTP 500', async () => ({ ok: false, json: async () => ({ success: true }) })],
      [
        'red caída',
        async () => {
          throw new TypeError('fetch failed');
        },
      ],
    ] as [string, FetchLike][])('%s: 403 y no se guarda nada', async (_n, fetch) => {
      const s = real(fetch);
      const res = await s.call(validBody());
      expect(res.statusCode).toBe(403);
      expect(s.repo.quotes.size).toBe(0);
      expect(s.repo.calls).toEqual([]);
    });

    it('SSM sin parámetro: 403', async () => {
      const fetch = vi.fn();
      const s = real(fetch as never, async () => {
        throw new Error('ParameterNotFound');
      });
      expect((await s.call(validBody())).statusCode).toBe(403);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('timeout de Turnstile: 403', async () => {
      vi.useFakeTimers();
      const s = real(() => new Promise(() => undefined));
      const p = s.call(validBody());
      await vi.advanceTimersByTimeAsync(3100);
      expect((await p).statusCode).toBe(403);
      expect(s.repo.quotes.size).toBe(0);
    });

    it('el secreto no aparece en la respuesta ni en los logs', async () => {
      const s = real(async () => {
        throw new Error('falló con s3cr3t');
      });
      const res = await s.call(validBody());
      expect(res.body).not.toContain('s3cr3t');
      expect(s.logs.join('\n')).not.toContain('s3cr3t');
    });
  });
});

describe('piedras y tarifa', () => {
  it('sin tarifa activa: 503 quotes_unavailable, sin consumir folio', async () => {
    const s = setup();
    s.repo.activeFreight = null;
    const res = await s.call(validBody());
    expect(res.statusCode).toBe(503);
    expect(json(res)).toEqual({ error: 'quotes_unavailable' });
    expect(s.repo.counters.size).toBe(0);
    expect(s.repo.quotes.size).toBe(0);
  });

  it('tarifa corrupta: 503 quotes_unavailable', async () => {
    const s = setup();
    s.repo.activeFreight = { version: 't0002', basura: true };
    expect((await s.call(validBody())).statusCode).toBe(503);
  });

  it('piedra corrupta en el catálogo: 503 quotes_unavailable', async () => {
    const s = setup();
    s.repo.stones.set('caliza', { id: 'caliza', basura: 1 });
    expect((await s.call(validBody())).statusCode).toBe(503);
    expect(s.repo.counters.size).toBe(0);
  });

  it.each([
    [
      'piedra inexistente',
      [{ stoneId: 'no-existe', cantidad: 1, unidad: 'tonelada' }],
      'no-existe',
    ],
    ['piedra inactiva', [{ stoneId: 'travertino', cantidad: 1, unidad: 'tonelada' }], 'travertino'],
    [
      'acabado que la piedra no ofrece',
      [{ stoneId: 'caliza', acabado: 'Pulido espejo', cantidad: 1, unidad: 'tonelada' }],
      'Pulido espejo',
    ],
    ['unidad no vendida', [{ stoneId: 'arenisca', cantidad: 1, unidad: 'pieza' }], 'arenisca'],
    [
      'espesor no disponible',
      [{ stoneId: 'arenisca', cantidad: 1, unidad: 'm2', espesorCm: 7 }],
      'arenisca',
    ],
    [
      'pedido demasiado grande',
      [{ stoneId: 'caliza', cantidad: 100_000, unidad: 'tonelada' }],
      'caliza',
    ],
  ])(
    '%s: 422 con mensaje genérico en español, sin eco, sin guardar ni gastar folio',
    async (_n, items, eco) => {
      const s = setup();
      const res = await s.call(validBody({ items }));
      expect(res.statusCode).toBe(422);
      const body = json(res);
      expect(body.error).toBe('validation_error');
      const issues = body.issues as { path: string; message: string }[];
      expect(issues).toHaveLength(1);
      expect(issues[0]!.path).toBe('items');
      expect(issues[0]!.message).toMatch(/[a-záéíóú]/i);
      expect(res.body).not.toContain(eco);
      expect(s.repo.quotes.size).toBe(0);
      expect(s.repo.counters.size).toBe(0);
      expect(s.sent).toEqual([]);
    },
  );
});

describe('fallos de infraestructura', () => {
  it('contador agotado (99 999): 503 quotes_unavailable, nada guardado ni enviado', async () => {
    const s = setup();
    s.repo.counters.set(2026, 99_999);
    const res = await s.call(validBody());
    expect(res.statusCode).toBe(503);
    expect(json(res)).toEqual({ error: 'quotes_unavailable' });
    expect(s.repo.quotes.size).toBe(0);
    expect(s.sent).toEqual([]);
  });

  it('el folio 99 999 todavía se concede', async () => {
    const s = setup();
    s.repo.counters.set(2026, 99_998);
    expect(json(await s.call(validBody())).folio).toBe('CN-2026-99999');
  });

  it('un contador que devuelve más de 99 999: 503 (defensa en profundidad)', async () => {
    const s = setup();
    vi.spyOn(s.repo, 'reserveFolioNumber').mockResolvedValue(100_000);
    expect((await s.call(validBody())).statusCode).toBe(503);
    expect(s.repo.quotes.size).toBe(0);
  });

  it('Put duplicado: 500 internal_error, sin correos', async () => {
    const s = setup();
    s.repo.failOn.set('putQuote', new DuplicateQuoteError());
    const res = await s.call(validBody(), { requestId: 'req-dup' });
    expect(res.statusCode).toBe(500);
    expect(json(res)).toEqual({ error: 'internal_error', requestId: 'req-dup' });
    expect(s.sent).toEqual([]);
  });

  it.each(['getActiveFreightRow', 'getStones', 'reserveFolioNumber', 'putQuote'] as const)(
    '%s lanza: 500 internal_error sin detalles ni PII, sin correos',
    async (metodo) => {
      const s = setup();
      s.repo.failOn.set(
        metodo,
        Object.assign(new Error(`falló con ${SENTINEL.correo} ${SENTINEL.nombre}`), {
          name: 'DynamoFalla',
        }),
      );
      const res = await s.call(validBody(), { requestId: 'req-9' });
      expect(res.statusCode).toBe(500);
      expect(json(res)).toEqual({ error: 'internal_error', requestId: 'req-9' });
      expect(res.body).not.toContain(SENTINEL.correo);
      expect(s.sent).toEqual([]);
      const todo = s.logs.join('\n');
      for (const v of [SENTINEL.correo, SENTINEL.nombre, SENTINEL.telefono])
        expect(todo).not.toContain(v);
      expect(todo).toContain('req-9');
    },
  );
});

describe('logs sin datos personales', () => {
  it('un envío completo no deja body, correo, teléfono, nombre, lugar, notas ni token en los logs', async () => {
    const s = setup({ captcha: { verify: async () => true } });
    await s.call(validBody({ turnstileToken: SENTINEL.token }), { requestId: 'req-log' });
    const todo = s.logs.join('\n');
    expect(s.logs.length).toBeGreaterThan(0);
    for (const v of Object.values(SENTINEL)) expect(todo, v).not.toContain(v);
    expect(todo).not.toContain('"customer"');
    expect(todo).not.toContain('"items"');
    expect(todo).toContain('quote_created');
    expect(todo).toContain('CN-2026-00001');
    expect(todo).toContain('req-log');
  });

  it('la validación fallida tampoco registra el cuerpo', async () => {
    const s = setup();
    await s.call(validBody({ consent: false, turnstileToken: SENTINEL.token }));
    const todo = s.logs.join('\n');
    for (const v of Object.values(SENTINEL)) expect(todo, v).not.toContain(v);
  });

  it('el captcha fallido no registra el token', async () => {
    const s = setup();
    await s.call(validBody({ turnstileToken: SENTINEL.token }));
    expect(s.logs.join('\n')).not.toContain(SENTINEL.token);
  });

  it('un fallo de correo con el destinatario en el mensaje no lo filtra', async () => {
    const s = setup({
      mailer: {
        send: async () => {
          throw new Error(`rechazado: ${SENTINEL.correo} (${SENTINEL.nombre}, ${SENTINEL.lugar})`);
        },
      },
    });
    await s.call(validBody());
    const todo = s.logs.join('\n');
    for (const v of [SENTINEL.correo, SENTINEL.nombre, SENTINEL.lugar])
      expect(todo).not.toContain(v);
    expect(todo).toContain('CN-2026-00001');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCaptchaVerifier,
  FakeCaptchaVerifier,
  SsmSecretProvider,
  TURNSTILE_VERIFY_URL,
  TurnstileVerifier,
  type FetchLike,
} from '../captcha';

afterEach(() => vi.useRealTimers());

const SECRETO = 'SECRETO-TURNSTILE-12345';

interface Call {
  url: string;
  init: Parameters<FetchLike>[1];
}

function fakeFetch(respond: (call: Call) => Promise<{ ok: boolean; json(): Promise<unknown> }>) {
  const calls: Call[] = [];
  const fetch: FetchLike = (url, init) => {
    const call = { url, init };
    calls.push(call);
    return respond(call);
  };
  return { fetch, calls };
}
const ok = (body: unknown) => async () => ({ ok: true, json: async () => body });

describe('FakeCaptchaVerifier (solo emulador)', () => {
  it('acepta únicamente el token literal test-pass', async () => {
    const v = new FakeCaptchaVerifier();
    expect(await v.verify({ token: 'test-pass' })).toBe(true);
    for (const t of ['', 'test-fail', 'TEST-PASS', 'test-pass ', 'cualquier-cosa']) {
      expect(await v.verify({ token: t }), t).toBe(false);
    }
  });
});

describe('TurnstileVerifier', () => {
  const make = (
    f: FetchLike,
    over: Partial<ConstructorParameters<typeof TurnstileVerifier>[0]> = {},
  ) => new TurnstileVerifier({ secret: async () => SECRETO, fetch: f, ...over });

  it('manda secret y response a la URL oficial y acepta success:true', async () => {
    const { fetch, calls } = fakeFetch(ok({ success: true, hostname: 'sitio.example' }));
    expect(await make(fetch).verify({ token: 'tok-1' })).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    expect(calls[0]!.url).toBe(TURNSTILE_VERIFY_URL);
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(calls[0]!.init.body)).toEqual({ secret: SECRETO, response: 'tok-1' });
  });

  it('manda remoteip solo si el evento lo trae', async () => {
    const { fetch, calls } = fakeFetch(ok({ success: true }));
    await make(fetch).verify({ token: 't', remoteIp: '203.0.113.7' });
    expect(JSON.parse(calls[0]!.init.body)).toEqual({
      secret: SECRETO,
      response: 't',
      remoteip: '203.0.113.7',
    });
    await make(fetch).verify({ token: 't' });
    expect(JSON.parse(calls[1]!.init.body)).not.toHaveProperty('remoteip');
  });

  it('no sigue redirecciones (el secreto no debe viajar a otro host)', async () => {
    const { fetch, calls } = fakeFetch(ok({ success: true }));
    await make(fetch).verify({ token: 't' });
    expect(calls[0]!.init.redirect).toBe('error');
  });

  describe('hostname de la respuesta (el widget se resolvió en NUESTRO sitio)', () => {
    const verify = async (body: unknown, allowedHostnames?: string[]) => {
      const { fetch } = fakeFetch(ok(body));
      return make(fetch, allowedHostnames === undefined ? {} : { allowedHostnames }).verify({
        token: 't',
      });
    };

    it('hostname dentro de la lista: pasa (sin distinguir mayúsculas)', async () => {
      expect(await verify({ success: true, hostname: 'sitio.example' }, ['sitio.example'])).toBe(
        true,
      );
      expect(await verify({ success: true, hostname: 'SITIO.Example' }, ['sitio.example'])).toBe(
        true,
      );
      expect(
        await verify({ success: true, hostname: 'localhost' }, ['sitio.example', 'localhost']),
      ).toBe(true);
    });

    it('hostname de OTRO sitio (token resuelto en una página del atacante): falla cerrado', async () => {
      expect(await verify({ success: true, hostname: 'evil.example' }, ['sitio.example'])).toBe(
        false,
      );
      expect(
        await verify({ success: true, hostname: 'sitio.example.evil.example' }, ['sitio.example']),
      ).toBe(false);
      expect(await verify({ success: true, hostname: '' }, ['sitio.example'])).toBe(false);
    });

    it('hostname presente pero que no es texto: falla cerrado', async () => {
      for (const hostname of [null, 5, ['sitio.example'], {}]) {
        expect(await verify({ success: true, hostname }, ['sitio.example']), String(hostname)).toBe(
          false,
        );
      }
    });

    it('si el campo no viene, no se exige (Cloudflare no siempre lo manda)', async () => {
      expect(await verify({ success: true }, ['sitio.example'])).toBe(true);
    });

    it('sin lista configurada no se valida el hostname', async () => {
      expect(await verify({ success: true, hostname: 'cualquiera.example' })).toBe(true);
      expect(await verify({ success: true, hostname: 'cualquiera.example' }, [])).toBe(true);
    });

    it('success:false sigue fallando aunque el hostname coincida', async () => {
      expect(await verify({ success: false, hostname: 'sitio.example' }, ['sitio.example'])).toBe(
        false,
      );
    });
  });

  describe('falla CERRADO', () => {
    it.each([
      ['success:false', { success: false, 'error-codes': ['invalid-input-response'] }],
      ['timeout-or-duplicate', { success: false, 'error-codes': ['timeout-or-duplicate'] }],
      ['success como texto', { success: 'true' }],
      ['success como 1', { success: 1 }],
      ['sin success', { hostname: 'x' }],
      ['objeto vacío', {}],
      ['null', null],
      ['arreglo', [{ success: true }]],
      ['texto', 'ok'],
      ['número', 1],
    ])('respuesta rara: %s', async (_n, body) => {
      const { fetch } = fakeFetch(ok(body));
      expect(await make(fetch).verify({ token: 't' })).toBe(false);
    });

    it('HTTP no 2xx aunque el cuerpo diga success:true', async () => {
      const { fetch } = fakeFetch(async () => ({
        ok: false,
        json: async () => ({ success: true }),
      }));
      expect(await make(fetch).verify({ token: 't' })).toBe(false);
    });

    it('respuesta que no es JSON', async () => {
      const { fetch } = fakeFetch(async () => ({
        ok: true,
        json: async () => {
          throw new SyntaxError('Unexpected token <');
        },
      }));
      expect(await make(fetch).verify({ token: 't' })).toBe(false);
    });

    it('error de red', async () => {
      const { fetch } = fakeFetch(async () => {
        throw new TypeError('fetch failed');
      });
      expect(await make(fetch).verify({ token: 't' })).toBe(false);
    });

    it('SSM falla o no hay parámetro (el secreto no se pudo leer): no llama a Turnstile', async () => {
      const { fetch, calls } = fakeFetch(ok({ success: true }));
      const v = make(fetch, {
        secret: async () => {
          throw new Error('ParameterNotFound');
        },
      });
      expect(await v.verify({ token: 't' })).toBe(false);
      expect(calls).toHaveLength(0);
    });

    it.each(['', '   '])('secreto vacío (%j): no llama a Turnstile', async (vacio) => {
      const { fetch, calls } = fakeFetch(ok({ success: true }));
      expect(await make(fetch, { secret: async () => vacio }).verify({ token: 't' })).toBe(false);
      expect(calls).toHaveLength(0);
    });

    it('token vacío o demasiado largo: ni siquiera se consulta', async () => {
      const { fetch, calls } = fakeFetch(ok({ success: true }));
      const v = make(fetch);
      expect(await v.verify({ token: '' })).toBe(false);
      expect(await v.verify({ token: 'x'.repeat(2049) })).toBe(false);
      expect(calls).toHaveLength(0);
    });

    it('timeout de 3 s con fetch que respeta la señal', async () => {
      vi.useFakeTimers();
      let signal: AbortSignal | undefined;
      const { fetch } = fakeFetch(
        ({ init }) =>
          new Promise((_resolve, reject) => {
            signal = init.signal;
            init.signal.addEventListener('abort', () =>
              reject(new DOMException('abortado', 'AbortError')),
            );
          }),
      );
      const p = make(fetch).verify({ token: 't' });
      await vi.advanceTimersByTimeAsync(2999);
      expect(signal!.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(await p).toBe(false);
      expect(signal!.aborted).toBe(true);
    });

    it('timeout aunque el fetch IGNORE la señal (nunca se queda colgado)', async () => {
      vi.useFakeTimers();
      const { fetch } = fakeFetch(() => new Promise(() => undefined));
      const p = make(fetch).verify({ token: 't' });
      await vi.advanceTimersByTimeAsync(3001);
      expect(await p).toBe(false);
    });

    it('timeout también mientras se lee el cuerpo', async () => {
      vi.useFakeTimers();
      const { fetch } = fakeFetch(async () => ({
        ok: true,
        json: () => new Promise(() => undefined),
      }));
      const p = make(fetch).verify({ token: 't' });
      await vi.advanceTimersByTimeAsync(3001);
      expect(await p).toBe(false);
    });
  });

  it('el secreto no aparece en nada que devuelva ni en el mensaje de un fallo', async () => {
    const { fetch } = fakeFetch(async () => {
      throw new Error(`falló con ${SECRETO}`);
    });
    const r = await make(fetch).verify({ token: 't' });
    expect(r).toBe(false);
  });
});

describe('SsmSecretProvider', () => {
  const NOMBRE = '/canteras/dev/turnstile-secret';

  it('pide el parámetro con WithDecryption y devuelve su valor', async () => {
    const sent: unknown[] = [];
    const client = {
      send: async (cmd: unknown) => {
        sent.push(cmd);
        return { Parameter: { Name: NOMBRE, Value: SECRETO } };
      },
    };
    expect(await new SsmSecretProvider(client, NOMBRE).get()).toBe(SECRETO);
    const input = (sent[0] as { input: unknown }).input;
    expect(input).toEqual({ Name: NOMBRE, WithDecryption: true });
  });

  it('cachea en memoria 5 minutos y luego vuelve a pedirlo', async () => {
    let n = 0;
    let now = 1_000;
    const client = {
      send: async () => {
        n++;
        return { Parameter: { Value: `${SECRETO}-${n}` } };
      },
    };
    const p = new SsmSecretProvider(client, NOMBRE, { now: () => now });
    expect(await p.get()).toBe(`${SECRETO}-1`);
    now += 299_000;
    expect(await p.get()).toBe(`${SECRETO}-1`);
    now += 2_000;
    expect(await p.get()).toBe(`${SECRETO}-2`);
  });

  it.each([
    ['sin Parameter', {}],
    ['sin Value', { Parameter: { Name: NOMBRE } }],
    ['Value vacío', { Parameter: { Value: '' } }],
    ['Value no es texto', { Parameter: { Value: 5 } }],
  ])('respuesta inválida (%s): lanza', async (_n, out) => {
    const p = new SsmSecretProvider({ send: async () => out }, NOMBRE);
    await expect(p.get()).rejects.toThrow();
  });

  it('un error de SSM se propaga y NO se cachea', async () => {
    let falla = true;
    const client = {
      send: async () => {
        if (falla) throw new Error('AccessDenied');
        return { Parameter: { Value: SECRETO } };
      },
    };
    const p = new SsmSecretProvider(client, NOMBRE);
    await expect(p.get()).rejects.toThrow();
    falla = false;
    expect(await p.get()).toBe(SECRETO);
  });
});

describe('createCaptchaVerifier', () => {
  const deps = { ssm: () => ({ send: async () => ({ Parameter: { Value: SECRETO } }) }) };

  it('modo fake: verificador de emulador', async () => {
    const v = createCaptchaVerifier({ turnstileMode: 'fake' }, deps);
    expect(v).toBeInstanceOf(FakeCaptchaVerifier);
  });

  it('con parámetro: Turnstile real', () => {
    expect(createCaptchaVerifier({ turnstileSecretParam: '/a/b' }, deps)).toBeInstanceOf(
      TurnstileVerifier,
    );
  });

  it('sin modo fake ni parámetro: null (la ruta falla cerrado)', () => {
    expect(createCaptchaVerifier({}, deps)).toBeNull();
  });

  it('con parámetro y hostnames permitidos: el verificador real los aplica', async () => {
    const fetch: FetchLike = async () => ({
      ok: true,
      json: async () => ({ success: true, hostname: 'evil.example' }),
    });
    const v = createCaptchaVerifier(
      { turnstileSecretParam: '/a/b', turnstileAllowedHostnames: ['sitio.example'] },
      { ...deps, fetch },
    );
    expect(await v!.verify({ token: 't' })).toBe(false);
  });

  it('modo fake: ignora los hostnames (no habla con Turnstile)', async () => {
    const v = createCaptchaVerifier(
      { turnstileMode: 'fake', turnstileAllowedHostnames: ['sitio.example'] },
      deps,
    );
    expect(await v!.verify({ token: 'test-pass' })).toBe(true);
  });

  it('no crea el cliente de SSM en modo fake ni sin parámetro', () => {
    const ssm = vi.fn(() => ({ send: async () => ({}) }));
    createCaptchaVerifier({ turnstileMode: 'fake' }, { ssm });
    createCaptchaVerifier({}, { ssm });
    expect(ssm).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from 'vitest';
import {
  GithubRebuilder,
  isValidRef,
  isValidRepository,
  isValidWorkflowFile,
  NoopRebuilder,
  REBUILD_TIMEOUT_MS,
  type DispatchFetch,
  type SiteRebuilder,
} from '../site-rebuild';

const TOKEN = 'github_pat_CENTINELA_NO_DEBE_SALIR';
const INPUT = { version: 'v0007', requestId: 'req-123' };

interface Captured {
  url: string;
  init: Parameters<DispatchFetch>[1];
}

function build(
  over: {
    fetch?: DispatchFetch;
    token?: () => Promise<string>;
    timeoutMs?: number;
  } = {},
) {
  const calls: Captured[] = [];
  const inner: DispatchFetch = over.fetch ?? (async () => ({ status: 204 }));
  const rebuilder = new GithubRebuilder({
    token: over.token ?? (async () => TOKEN),
    repository: 'mi-dueno/mi-repo',
    workflowFile: 'site-build.yml',
    ref: 'main',
    fetch: async (url, init) => {
      calls.push({ url, init });
      return inner(url, init);
    },
    ...(over.timeoutMs === undefined ? {} : { timeoutMs: over.timeoutMs }),
  });
  return { rebuilder, calls };
}

describe('NoopRebuilder', () => {
  it('responde not_configured sin hacer nada', async () => {
    const noop: SiteRebuilder = new NoopRebuilder();
    expect(await noop.request(INPUT)).toEqual({ status: 'not_configured' });
  });
});

describe('GithubRebuilder: la petición', () => {
  it('hace POST a la API de dispatches del workflow con las cabeceras y el cuerpo esperados', async () => {
    const { rebuilder, calls } = build();
    expect(await rebuilder.request(INPUT)).toEqual({ status: 'requested' });
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0] as Captured;
    expect(url).toBe(
      'https://api.github.com/repos/mi-dueno/mi-repo/actions/workflows/site-build.yml/dispatches',
    );
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(init.headers['accept']).toBe('application/vnd.github+json');
    expect(init.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(init.headers['x-github-api-version']).toBe('2022-11-28');
    expect(init.headers['user-agent']).toBeTruthy();
    expect(JSON.parse(init.body)).toEqual({ ref: 'main', inputs: { version: 'v0007' } });
  });

  it('las cabeceras son EXACTAMENTE estas y el token solo viaja en authorization', async () => {
    const { rebuilder, calls } = build();
    await rebuilder.request(INPUT);
    const headers = (calls[0] as Captured).init.headers;
    expect(Object.keys(headers).sort()).toEqual([
      'accept',
      'authorization',
      'content-type',
      'user-agent',
      'x-github-api-version',
    ]);
    for (const [nombre, valor] of Object.entries(headers)) {
      if (nombre === 'authorization') continue;
      expect(valor, nombre).not.toContain(TOKEN);
    }
  });

  it('recorta el token antes de armar la cabecera (sin «Bearer  tok»)', async () => {
    const { rebuilder, calls } = build({ token: async () => `  ${TOKEN}\n` });
    expect(await rebuilder.request(INPUT)).toEqual({ status: 'requested' });
    expect((calls[0] as Captured).init.headers['authorization']).toBe(`Bearer ${TOKEN}`);
  });

  it('el cuerpo no contiene el token ni el requestId', async () => {
    const { rebuilder, calls } = build();
    await rebuilder.request(INPUT);
    const body = (calls[0] as Captured).init.body;
    expect(body).not.toContain(TOKEN);
    expect(body).not.toContain('req-123');
  });

  it.each([200, 204])('el estado %i cuenta como éxito', async (status) => {
    const { rebuilder } = build({ fetch: async () => ({ status }) });
    expect(await rebuilder.request(INPUT)).toEqual({ status: 'requested' });
  });
});

describe('GithubRebuilder: fallos (best-effort, nunca lanza)', () => {
  it.each([201, 301, 401, 403, 404, 422, 429, 500, 502, 503])(
    'HTTP %i: failed con motivo http_<código>',
    async (status) => {
      const { rebuilder } = build({ fetch: async () => ({ status }) });
      expect(await rebuilder.request(INPUT)).toEqual({
        status: 'failed',
        reason: `http_${status}`,
      });
    },
  );

  it('error de red: failed sin filtrar el mensaje del error', async () => {
    const { rebuilder } = build({
      fetch: async () => {
        throw new Error(`fallo con ${TOKEN} dentro`);
      },
    });
    const out = await rebuilder.request(INPUT);
    expect(out).toEqual({ status: 'failed', reason: 'network_error' });
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  it('SSM caído: failed token_unavailable y no llama a GitHub', async () => {
    const { rebuilder, calls } = build({
      token: async () => {
        throw new Error('AccessDenied');
      },
    });
    expect(await rebuilder.request(INPUT)).toEqual({
      status: 'failed',
      reason: 'token_unavailable',
    });
    expect(calls).toHaveLength(0);
  });

  it.each(['', '   '])(
    'token vacío (%j): failed token_empty y no llama a GitHub',
    async (vacio) => {
      const { rebuilder, calls } = build({ token: async () => vacio });
      expect(await rebuilder.request(INPUT)).toEqual({ status: 'failed', reason: 'token_empty' });
      expect(calls).toHaveLength(0);
    },
  );

  it('el plazo total es de 3 s por defecto', () => {
    expect(REBUILD_TIMEOUT_MS).toBe(3000);
  });

  it('si GitHub no responde a tiempo: timeout y se aborta la petición', async () => {
    let signal: AbortSignal | undefined;
    const { rebuilder } = build({
      timeoutMs: 20,
      fetch: (_url, init) => {
        signal = init.signal;
        return new Promise(() => undefined);
      },
    });
    expect(await rebuilder.request(INPUT)).toEqual({ status: 'failed', reason: 'timeout' });
    expect(signal?.aborted).toBe(true);
  });

  it('el plazo incluye la lectura del token en SSM', async () => {
    const { rebuilder, calls } = build({
      timeoutMs: 20,
      token: () => new Promise(() => undefined),
    });
    expect(await rebuilder.request(INPUT)).toEqual({ status: 'failed', reason: 'timeout' });
    expect(calls).toHaveLength(0);
  });

  it('con un plazo vencido, una respuesta tardía no cambia el resultado', async () => {
    const { rebuilder } = build({
      timeoutMs: 20,
      fetch: () => new Promise((resolve) => setTimeout(() => resolve({ status: 204 }), 60)),
    });
    expect(await rebuilder.request(INPUT)).toEqual({ status: 'failed', reason: 'timeout' });
  });
});

describe('GithubRebuilder: validación de la configuración', () => {
  const base = {
    token: async () => TOKEN,
    repository: 'mi-dueno/mi-repo',
    workflowFile: 'site-build.yml',
    ref: 'main',
  };

  it.each([
    ['repository', { repository: 'sin-barra' }],
    ['repository', { repository: 'a/b/c' }],
    ['repository', { repository: 'a/b?x=1' }],
    ['repository', { repository: '../x' }],
    ['workflowFile', { workflowFile: 'site-build.txt' }],
    ['workflowFile', { workflowFile: '../site-build.yml' }],
    ['workflowFile', { workflowFile: 'a/b.yml' }],
    ['ref', { ref: '' }],
    ['ref', { ref: 'main; rm' }],
    ['ref', { ref: '-main' }],
  ])('rechaza un %s inválido', (_campo, over) => {
    expect(() => new GithubRebuilder({ ...base, ...over })).toThrow();
  });

  it('los validadores aceptan valores normales', () => {
    expect(isValidRepository('canteras/stone-store')).toBe(true);
    expect(isValidRepository('a.b_c-d/e.f')).toBe(true);
    expect(isValidWorkflowFile('site-build.yml')).toBe(true);
    expect(isValidWorkflowFile('build.yaml')).toBe(true);
    expect(isValidRef('main')).toBe(true);
    expect(isValidRef('release/dev')).toBe(true);
  });
});

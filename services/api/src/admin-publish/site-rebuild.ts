// Pide a GitHub Actions que reconstruya el sitio público tras publicar o revertir el catálogo.
// API: POST /repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches
// (https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event).
//
// BEST-EFFORT: `request` nunca lanza. El resultado de fallo lleva un `reason` (código corto) SOLO
// para el log estructurado; jamás el token, el cuerpo de la respuesta ni el mensaje crudo de un error.

export type RebuildOutcome =
  { status: 'requested' } | { status: 'not_configured' } | { status: 'failed'; reason: string };

export interface SiteRebuilder {
  request(input: { version: string; requestId: string }): Promise<RebuildOutcome>;
}

/** Sin configuración (o con emulador): no hace nada y lo informa. */
export class NoopRebuilder implements SiteRebuilder {
  async request(): Promise<RebuildOutcome> {
    return { status: 'not_configured' };
  }
}

/** Lo mínimo que se usa de `fetch` (se inyecta para probar sin red). */
export type DispatchFetch = (
  url: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
    redirect: 'error';
  },
) => Promise<{ status: number }>;

/** Plazo TOTAL de la petición, incluida la lectura del token en SSM. */
export const REBUILD_TIMEOUT_MS = 3000;
const API_VERSION = '2022-11-28';

const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const WORKFLOW_PATTERN = /^[A-Za-z0-9._-]+\.ya?ml$/;
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

export const isValidRepository = (v: string): boolean =>
  REPOSITORY_PATTERN.test(v) && !v.split('/').some((p) => p === '.' || p === '..');
export const isValidWorkflowFile = (v: string): boolean =>
  WORKFLOW_PATTERN.test(v) && !v.includes('..');
export const isValidRef = (v: string): boolean => REF_PATTERN.test(v) && !v.includes('..');

export interface GithubRebuilderDeps {
  /** Lee el token (SSM). Su valor solo vive en memoria. */
  token: () => Promise<string>;
  /** `<dueño>/<repositorio>`. */
  repository: string;
  /** Nombre del archivo del workflow, p. ej. `site-build.yml`. */
  workflowFile: string;
  /** Rama donde corre el workflow. */
  ref: string;
  fetch?: DispatchFetch;
  timeoutMs?: number;
}

export class GithubRebuilder implements SiteRebuilder {
  constructor(private readonly deps: GithubRebuilderDeps) {
    if (!isValidRepository(deps.repository))
      throw new Error('Repositorio de reconstrucción no válido.');
    if (!isValidWorkflowFile(deps.workflowFile))
      throw new Error('Workflow de reconstrucción no válido.');
    if (!isValidRef(deps.ref)) throw new Error('Rama de reconstrucción no válida.');
  }

  async request(input: { version: string; requestId: string }): Promise<RebuildOutcome> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<RebuildOutcome>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ status: 'failed', reason: 'timeout' });
      }, this.deps.timeoutMs ?? REBUILD_TIMEOUT_MS);
    });
    try {
      return await Promise.race([this.dispatch(input, controller.signal), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** No lanza nunca: cada rama devuelve un resultado. */
  private async dispatch(input: { version: string }, signal: AbortSignal): Promise<RebuildOutcome> {
    const { repository, workflowFile, ref } = this.deps;
    let token: string;
    try {
      const raw = await this.deps.token();
      // Defensa en profundidad: un espacio inicial dejaría `Bearer  tok` y GitHub respondería 401.
      token = typeof raw === 'string' ? raw.trim() : '';
    } catch {
      return { status: 'failed', reason: 'token_unavailable' };
    }
    if (token === '') {
      return { status: 'failed', reason: 'token_empty' };
    }
    const send: DispatchFetch = this.deps.fetch ?? ((u, i) => fetch(u, i));
    const url = `https://api.github.com/repos/${repository}/actions/workflows/${workflowFile}/dispatches`;
    try {
      const res = await send(url, {
        method: 'POST',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'x-github-api-version': API_VERSION,
          'user-agent': 'canteras-admin-publish',
          'content-type': 'application/json',
        },
        // Solo la versión del catálogo: el workflow la usa como mínima exigida.
        body: JSON.stringify({ ref, inputs: { version: input.version } }),
        signal,
        // Una redirección podría llevar el token a otro host: se rechaza.
        redirect: 'error',
      });
      // La doc actual muestra 200 (con el id de la ejecución); históricamente fue 204: ambos valen.
      if (res.status === 200 || res.status === 204) return { status: 'requested' };
      return { status: 'failed', reason: `http_${res.status}` };
    } catch {
      return { status: 'failed', reason: 'network_error' };
    }
  }
}

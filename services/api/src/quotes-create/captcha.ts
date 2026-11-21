import { GetParameterCommand } from '@aws-sdk/client-ssm';
import type { SdkClient } from '../lib/mailer';

// Verificación anti-spam (Cloudflare Turnstile) detrás de una interfaz. Principio: FALLA CERRADO.
// Cualquier error (red, timeout, SSM, respuesta rara) cuenta como «no verificado».
// API consultada: https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
// (POST /turnstile/v0/siteverify con `secret`, `response` y `remoteip` opcional; respuesta con
// `success` booleano; el token mide a lo más 2048 caracteres, vale 5 minutos y es de un solo uso).

export interface CaptchaVerifier {
  verify(input: { token: string; remoteIp?: string | undefined }): Promise<boolean>;
}

export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const MAX_TOKEN_LENGTH = 2048;
const DEFAULT_TIMEOUT_MS = 3000;

/** Token literal que acepta el verificador de emulador. */
export const FAKE_CAPTCHA_TOKEN = 'test-pass';

/** SOLO emulador (`TURNSTILE_MODE=fake`): no habla con nadie y acepta únicamente `test-pass`. */
export class FakeCaptchaVerifier implements CaptchaVerifier {
  async verify(input: { token: string }): Promise<boolean> {
    return input.token === FAKE_CAPTCHA_TOKEN;
  }
}

/** Lo mínimo que se usa de `fetch` (se inyecta para probar sin red). */
export interface FetchResponseLike {
  ok: boolean;
  json(): Promise<unknown>;
}
export type FetchLike = (
  url: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
    redirect: 'error';
  },
) => Promise<FetchResponseLike>;

export interface TurnstileDeps {
  /** Devuelve el secreto (de SSM). Si lanza, la verificación falla. */
  secret: () => Promise<string>;
  fetch?: FetchLike;
  timeoutMs?: number;
  /**
   * Hostnames de NUESTRO sitio (derivados de SITE_ORIGINS). Si la respuesta de siteverify trae
   * `hostname`, debe estar aquí: un token resuelto en la página de un atacante (otro hostname) falla
   * cerrado. Sin lista (vacía o ausente) no se valida; si el campo no viene, tampoco se exige.
   */
  allowedHostnames?: readonly string[] | undefined;
}

export class TurnstileVerifier implements CaptchaVerifier {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(private readonly deps: TurnstileDeps) {
    this.fetchImpl = deps.fetch ?? ((url, init) => fetch(url, init));
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** `hostname` ausente: se acepta. Presente: debe ser texto y estar en la lista (si hay lista). */
  private hostnameAllowed(hostname: unknown): boolean {
    if (hostname === undefined) return true;
    const allowed = this.deps.allowedHostnames;
    if (allowed === undefined || allowed.length === 0) return true;
    if (typeof hostname !== 'string' || hostname === '') return false;
    return allowed.some((h) => h.toLowerCase() === hostname.toLowerCase());
  }

  async verify(input: { token: string; remoteIp?: string | undefined }): Promise<boolean> {
    const { token, remoteIp } = input;
    if (typeof token !== 'string' || token === '' || token.length > MAX_TOKEN_LENGTH) return false;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // El tiempo límite cubre TODO (secreto, petición y lectura del cuerpo) y se cumple aunque el
    // `fetch` ignore la señal: la promesa de abajo gana la carrera y la petición no se queda colgada.
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(false);
      }, this.timeoutMs);
    });
    const work = (async (): Promise<boolean> => {
      const secret = await this.deps.secret();
      if (typeof secret !== 'string' || secret.trim() === '') return false;
      const res = await this.fetchImpl(TURNSTILE_VERIFY_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          secret,
          response: token,
          ...(remoteIp === undefined || remoteIp === '' ? {} : { remoteip: remoteIp }),
        }),
        signal: controller.signal,
        // Una redirección podría llevar el secreto a otro host: se rechaza.
        redirect: 'error',
      });
      if (!res.ok) return false;
      const body = await res.json();
      if (
        typeof body !== 'object' ||
        body === null ||
        Array.isArray(body) ||
        (body as { success?: unknown }).success !== true
      ) {
        return false;
      }
      return this.hostnameAllowed((body as { hostname?: unknown }).hostname);
    })().catch(() => false);

    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

const SECRET_TTL_MS = 5 * 60 * 1000;

/**
 * Lee el secreto de Turnstile de SSM Parameter Store (SecureString, `WithDecryption: true`) y lo
 * guarda en memoria 5 minutos. El valor nunca va a logs ni a variables de entorno. Un error no se cachea.
 */
export class SsmSecretProvider {
  private cached: { value: string; expiresAt: number } | null = null;
  private readonly now: () => number;

  constructor(
    private readonly client: SdkClient,
    private readonly name: string,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  async get(): Promise<string> {
    if (this.cached !== null && this.now() < this.cached.expiresAt) return this.cached.value;
    const out = (await this.client.send(
      new GetParameterCommand({ Name: this.name, WithDecryption: true }),
    )) as { Parameter?: { Value?: unknown } };
    const value = out.Parameter?.Value;
    if (typeof value !== 'string' || value === '') {
      throw new Error('El parámetro del secreto de Turnstile no tiene valor.');
    }
    this.cached = { value, expiresAt: this.now() + SECRET_TTL_MS };
    return value;
  }
}

export interface CaptchaEnv {
  turnstileMode?: 'fake' | undefined;
  turnstileSecretParam?: string | undefined;
  /** Hostnames de nuestro sitio para validar `hostname` de siteverify (ver `TurnstileDeps`). */
  turnstileAllowedHostnames?: readonly string[] | undefined;
}

/**
 * Elige el verificador: `fake` (solo emulador), Turnstile real si hay parámetro SSM, o `null` (la
 * ruta responde 503 `captcha_not_configured`: nunca se acepta sin verificar).
 */
export function createCaptchaVerifier(
  env: CaptchaEnv,
  deps: { ssm: () => SdkClient; fetch?: FetchLike },
): CaptchaVerifier | null {
  if (env.turnstileMode === 'fake') return new FakeCaptchaVerifier();
  if (env.turnstileSecretParam !== undefined && env.turnstileSecretParam !== '') {
    const provider = new SsmSecretProvider(deps.ssm(), env.turnstileSecretParam);
    return new TurnstileVerifier({
      secret: () => provider.get(),
      allowedHostnames: env.turnstileAllowedHostnames,
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    });
  }
  return null;
}

import { GetParameterCommand } from '@aws-sdk/client-ssm';
import type { SdkClient } from './mailer';

const SECRET_TTL_MS = 5 * 60 * 1000;

/**
 * Lee un secreto de SSM Parameter Store (SecureString, `WithDecryption: true`) y lo guarda en
 * memoria 5 minutos. El valor nunca va a logs ni a variables de entorno. Un error NO se cachea.
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
    // Se recortan espacios y saltos de línea (un `put-parameter` desde la terminal suele dejar uno);
    // un valor que queda vacío es inválido y NO se cachea.
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed === '') {
      throw new Error('El parámetro del secreto en SSM no tiene valor.');
    }
    this.cached = { value: trimmed, expiresAt: this.now() + SECRET_TTL_MS };
    return trimmed;
  }
}

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CAPTCHA_TIMEOUT_MS } from '../captcha';
import { createQuotesCreateHandler, FREIGHT_TIMEOUT_MS } from '../create';
import { LAMBDA_TIMEOUT_MS, OTHER_WORK_ALLOWANCE_MS, SES_CLIENT_CONFIG } from '../budget';
import { event, seedRepo, validBody } from './fixtures';
import { MemoryQuotesCreateRepository } from './memory-repository';

afterEach(() => vi.useRealTimers());

const sesWorstCaseMs = (): number =>
  SES_CLIENT_CONFIG.requestHandler.connectionTimeout +
  SES_CLIENT_CONFIG.requestHandler.requestTimeout;

describe('presupuesto de tiempo de POST /quotes (Lambda de 10 s)', () => {
  it('el cliente de SES tiene plazos propios y un solo intento (el SDK por defecto espera sin límite)', () => {
    expect(SES_CLIENT_CONFIG.maxAttempts).toBe(1);
    expect(SES_CLIENT_CONFIG.requestHandler.connectionTimeout).toBeGreaterThan(0);
    expect(SES_CLIENT_CONFIG.requestHandler.requestTimeout).toBeGreaterThan(0);
  });

  it('el plazo del estimado de flete es de 2 s', () => {
    expect(FREIGHT_TIMEOUT_MS).toBe(2000);
  });

  it('captcha + ruta + SES en su peor caso + el resto dejan margen frente a los 10 s', () => {
    const peorCaso =
      CAPTCHA_TIMEOUT_MS + FREIGHT_TIMEOUT_MS + sesWorstCaseMs() + OTHER_WORK_ALLOWANCE_MS;
    expect(peorCaso).toBeLessThanOrEqual(LAMBDA_TIMEOUT_MS - 500);
  });

  it('con captcha, ruta colgada y SES en su peor caso el handler termina antes de 10 s', async () => {
    vi.useFakeTimers();
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const repo = new MemoryQuotesCreateRepository();
    seedRepo(repo);
    let doneAt = 0;
    const handler = createQuotesCreateHandler({
      repo,
      // Peor caso: el captcha tarda justo su plazo y aun así responde bien.
      captcha: {
        verify: async () => {
          await sleep(CAPTCHA_TIMEOUT_MS);
          return true;
        },
      },
      // Proveedor colgado: solo lo corta el plazo del estimado.
      routes: { getDistanceKm: () => new Promise<number>(() => undefined) },
      // SES tarda lo máximo que permite su cliente (conexión + petición, un intento).
      mailer: {
        send: async () => {
          await sleep(sesWorstCaseMs());
          doneAt = Date.now();
          return { messageId: 'x' };
        },
      },
    });
    const t0 = Date.now();
    const pending = handler.handle(event(validBody()));
    await vi.advanceTimersByTimeAsync(30_000);
    const res = await pending;
    // Los correos son lo último que hace el handler: su fin marca el fin del trabajo.
    const elapsed = doneAt - t0;
    expect(res.statusCode).toBe(201);
    expect(repo.quotes.size).toBe(1);
    expect(elapsed + OTHER_WORK_ALLOWANCE_MS).toBeLessThan(LAMBDA_TIMEOUT_MS);
  });
});

import { CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import { describe, expect, it } from 'vitest';
import { CLOUDFRONT_CLIENT_CONFIG, CloudFrontInvalidator, NoopInvalidator } from '../invalidator';

describe('NoopInvalidator', () => {
  it('no hace nada e informa skipped', async () => {
    expect(await new NoopInvalidator().invalidate()).toBe('skipped');
  });
});

describe('CloudFrontInvalidator', () => {
  it('crea una invalidación solo de las rutas pedidas, en la distribución indicada', async () => {
    const sent: { name: string; input: unknown }[] = [];
    const client = {
      async send(c: { constructor: { name: string }; input: unknown }) {
        sent.push({ name: c.constructor.name, input: c.input });
        return {};
      },
    };
    const inv = new CloudFrontInvalidator(client as never, 'E123', () => 'ref-1');
    expect(await inv.invalidate(['/published/catalog.json'])).toBe('ok');
    expect(sent[0]?.name).toBe(CreateInvalidationCommand.name);
    expect(sent[0]?.input).toEqual({
      DistributionId: 'E123',
      InvalidationBatch: {
        CallerReference: 'ref-1',
        Paths: { Quantity: 1, Items: ['/published/catalog.json'] },
      },
    });
  });

  it('propaga el error (quien llama decide qué hacer)', async () => {
    const client = {
      async send() {
        throw new Error('denegado');
      },
    };
    await expect(
      new CloudFrontInvalidator(client as never, 'E1').invalidate(['/x']),
    ).rejects.toThrow('denegado');
  });
});

describe('CLOUDFRONT_CLIENT_CONFIG', () => {
  it('un solo intento con plazos propios que caben en 3 s (1 s de conexión + 2 s de petición)', () => {
    expect(CLOUDFRONT_CLIENT_CONFIG.maxAttempts).toBe(1);
    const { connectionTimeout, requestTimeout } = CLOUDFRONT_CLIENT_CONFIG.requestHandler;
    expect(connectionTimeout).toBeGreaterThan(0);
    expect(requestTimeout).toBeGreaterThan(0);
    expect(connectionTimeout + requestTimeout).toBeLessThanOrEqual(3000);
  });
});

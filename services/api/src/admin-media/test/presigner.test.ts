import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPresigner, createS3Client } from '../presigner';

// Pruebas de integración LOCAL del presigner real: firmar no hace red (solo cálculo con las
// credenciales). Se usan credenciales falsas para que no dependa del entorno del equipo.
afterEach(() => vi.unstubAllEnvs());

function cliente(env: { S3_PUBLIC_ENDPOINT?: string } = {}): S3Client {
  return createS3Client(env, {
    region: 'us-east-1',
    credentials: { accessKeyId: 'AKIAFALSA', secretAccessKey: 'secreto-falso' },
  });
}

const comando = () =>
  new PutObjectCommand({
    Bucket: 'bucket-de-prueba',
    Key: 'stones/cantera-rosa/3f2b8c1e-9a4d-4e6b-8c7a-1d2e3f4a5b6c.png',
    ContentType: 'image/png',
    ContentLength: 2048,
  });

async function firmar(env: { S3_PUBLIC_ENDPOINT?: string } = {}) {
  const url = await createPresigner(cliente(env))(comando(), { expiresIn: 300 });
  return new URL(url);
}

describe('presigner real (sin red)', () => {
  it('firma content-type y content-length como cabeceras firmadas', async () => {
    const u = await firmar();
    const firmadas = (u.searchParams.get('X-Amz-SignedHeaders') ?? '').split(';');
    expect(firmadas).toContain('content-type');
    expect(firmadas).toContain('content-length');
    expect(firmadas).toContain('host');
  });

  it('la vigencia es de 300 s', async () => {
    expect((await firmar()).searchParams.get('X-Amz-Expires')).toBe('300');
  });

  it('no añade parámetros de checksum (el navegador no los envía)', async () => {
    const u = await firmar();
    expect(u.href.toLowerCase()).not.toContain('x-amz-checksum');
    expect(u.href.toLowerCase()).not.toContain('x-amz-sdk-checksum');
  });

  it('sin S3_PUBLIC_ENDPOINT usa el endpoint estándar de AWS (host virtual del bucket o regional)', async () => {
    const u = await firmar();
    expect(u.protocol).toBe('https:');
    expect(u.hostname).toMatch(/amazonaws\.com$/);
    expect(u.hostname).toContain('bucket-de-prueba'); // estilo virtual-hosted
  });

  it('con S3_PUBLIC_ENDPOINT apunta a ese host y usa path-style', async () => {
    const u = await firmar({ S3_PUBLIC_ENDPOINT: 'http://localhost:4566' });
    expect(u.origin).toBe('http://localhost:4566');
    expect(u.pathname).toBe(
      '/bucket-de-prueba/stones/cantera-rosa/3f2b8c1e-9a4d-4e6b-8c7a-1d2e3f4a5b6c.png',
    );
  });

  it('la URL incluye una firma y no expone la clave secreta', async () => {
    const u = await firmar();
    expect(u.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(u.href).not.toContain('secreto-falso');
  });

  it('un endpoint vacío se trata como ausente (cliente estándar)', async () => {
    const u = await firmar({ S3_PUBLIC_ENDPOINT: '' });
    expect(u.hostname).toMatch(/amazonaws\.com$/);
  });
});

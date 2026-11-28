import { describe, expect, it } from 'vitest';
import { SsmSecretProvider } from '../ssm-secret';

const NOMBRE = '/canteras/dev/algun-secreto';
const SECRETO = 'valor-secreto-de-prueba';

describe('SsmSecretProvider', () => {
  it('pide el parámetro con WithDecryption y devuelve su valor', async () => {
    const sent: unknown[] = [];
    const client = {
      send: async (cmd: unknown) => {
        sent.push(cmd);
        return { Parameter: { Name: NOMBRE, Value: SECRETO } };
      },
    };
    expect(await new SsmSecretProvider(client, NOMBRE).get()).toBe(SECRETO);
    expect((sent[0] as { input: unknown }).input).toEqual({ Name: NOMBRE, WithDecryption: true });
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
    expect(n).toBe(2);
  });

  it.each([
    ['sin Parameter', {}],
    ['sin Value', { Parameter: { Name: NOMBRE } }],
    ['Value vacío', { Parameter: { Value: '' } }],
    ['Value no es texto', { Parameter: { Value: 5 } }],
  ])('respuesta inválida (%s): lanza sin mencionar un servicio concreto', async (_n, out) => {
    const p = new SsmSecretProvider({ send: async () => out }, NOMBRE);
    const err = await p.get().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toMatch(/turnstile/i);
  });

  it('un error de SSM se propaga y NO se cachea', async () => {
    let falla = true;
    let llamadas = 0;
    const client = {
      send: async () => {
        llamadas++;
        if (falla) throw new Error('AccessDenied');
        return { Parameter: { Value: SECRETO } };
      },
    };
    const p = new SsmSecretProvider(client, NOMBRE);
    await expect(p.get()).rejects.toThrow('AccessDenied');
    falla = false;
    expect(await p.get()).toBe(SECRETO);
    expect(llamadas).toBe(2);
  });

  it('recorta espacios y saltos de línea alrededor del valor', async () => {
    const p = new SsmSecretProvider(
      { send: async () => ({ Parameter: { Value: `  ${SECRETO}\n` } }) },
      NOMBRE,
    );
    expect(await p.get()).toBe(SECRETO);
  });

  it('un valor solo con espacios es inválido y NO se cachea', async () => {
    let valor = '   \n';
    let llamadas = 0;
    const client = {
      send: async () => {
        llamadas++;
        return { Parameter: { Value: valor } };
      },
    };
    const p = new SsmSecretProvider(client, NOMBRE);
    await expect(p.get()).rejects.toThrow();
    valor = SECRETO;
    expect(await p.get()).toBe(SECRETO);
    expect(llamadas).toBe(2);
  });
});

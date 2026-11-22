import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  assertEmulator,
  emulatorEndpoint,
  FLOCI_IP,
  parseRole,
  parseTokenArgs,
  parseUsersArgs,
  pickAuthOutputs,
  validateEmail,
  validatePassword,
} from '../dev-lib';

const EMU = { AWS_ENDPOINT_URL: 'http://localhost:4566', AWS_ACCESS_KEY_ID: 'test' };
const PASS = 'Clave-De-Prueba-12';

describe('assertEmulator', () => {
  it('se niega a correr sin AWS_ENDPOINT_URL', () => {
    expect(() => assertEmulator({})).toThrow(/emulador/);
    expect(() => assertEmulator({ AWS_ENDPOINT_URL: '' })).toThrow(/emulador/);
  });
  it('se niega con APP_ENV=prod aunque haya emulador', () => {
    expect(() => assertEmulator({ ...EMU, APP_ENV: 'prod' })).toThrow(/prod/);
  });
  it.each([
    'https://cognito-idp.us-east-1.amazonaws.com',
    'https://localhost.evil.com',
    'http://localhost.evil.com:4566',
    'http://evil.com/localhost',
    'http://127.0.0.2:4566',
    'http://10.0.0.5:4566',
    'http://172.30.0.11:4566',
    'ftp://localhost',
    'localhost:4566',
    'no es una url',
  ])('rechaza el endpoint %s (podría ser AWS real)', (url) => {
    expect(() => assertEmulator({ ...EMU, AWS_ENDPOINT_URL: url })).toThrow(/endpoint|emulador/i);
  });

  it.each(['http://localhost:4566', 'http://127.0.0.1:4566', `http://${FLOCI_IP}:4566`])(
    'acepta el endpoint local %s',
    (url) => {
      expect(() => assertEmulator({ ...EMU, AWS_ENDPOINT_URL: url })).not.toThrow();
    },
  );

  it.each([undefined, '', 'AKIAREAL', 'Test', 'test '])(
    'exige AWS_ACCESS_KEY_ID exactamente "test" (recibió %j)',
    (key) => {
      const env: NodeJS.ProcessEnv = { ...EMU };
      if (key === undefined) delete env['AWS_ACCESS_KEY_ID'];
      else env['AWS_ACCESS_KEY_ID'] = key;
      expect(() => assertEmulator(env)).toThrow(/AWS_ACCESS_KEY_ID/);
    },
  );

  it('emulatorEndpoint devuelve el endpoint validado', () => {
    expect(emulatorEndpoint(EMU)).toBe('http://localhost:4566');
    expect(() => emulatorEndpoint({})).toThrow(/emulador/);
  });

  it('FLOCI_IP replicada coincide con infra/lib/config.ts', () => {
    const config = readFileSync(
      join(import.meta.dirname, '..', '..', 'infra', 'lib', 'config.ts'),
      'utf8',
    );
    expect(config).toContain(`export const FLOCI_IP = '${FLOCI_IP}';`);
  });

  it('acepta emulador con dev o sin APP_ENV', () => {
    expect(() => assertEmulator(EMU)).not.toThrow();
    expect(() => assertEmulator({ ...EMU, APP_ENV: 'dev' })).not.toThrow();
  });
});

describe('parseRole', () => {
  it.each(['owner', 'staff'])('acepta %s', (r) => {
    expect(parseRole(r)).toBe(r);
  });
  it.each(['Owner', 'admin', '', 'owner ', undefined])('rechaza %s', (r) => {
    expect(() => parseRole(r)).toThrow(/owner\|staff|owner/);
  });
});

describe('validateEmail', () => {
  it('acepta un correo normal', () => {
    expect(validateEmail('dueno@ejemplo.mx')).toBe('dueno@ejemplo.mx');
  });
  it('normaliza a minúsculas y recorta (el pool no distingue mayúsculas)', () => {
    expect(validateEmail('Dueno@Ejemplo.MX')).toBe('dueno@ejemplo.mx');
  });
  it.each(['', 'sin-arroba', 'a@b', 'a b@c.mx', undefined])('rechaza %s', (e) => {
    expect(() => validateEmail(e)).toThrow(/Correo inválido/);
  });
});

describe('validatePassword', () => {
  it('acepta una contraseña que cumple la política', () => {
    expect(validatePassword(PASS)).toBe(PASS);
  });
  it('exige que exista DEV_PASSWORD', () => {
    expect(() => validatePassword(undefined)).toThrow(/DEV_PASSWORD/);
  });
  it.each([
    ['corta', 'Aa1!aaaa'],
    ['sin mayúscula', 'clave-de-prueba-12'],
    ['sin minúscula', 'CLAVE-DE-PRUEBA-12'],
    ['sin número', 'Clave-De-Prueba-xx'],
    ['sin símbolo', 'ClaveDePrueba12x'],
  ])('rechaza contraseña %s sin imprimirla', (_n, pw) => {
    try {
      validatePassword(pw);
      throw new Error('debía fallar');
    } catch (e) {
      expect((e as Error).message).toMatch(/DEV_PASSWORD/);
      expect((e as Error).message).not.toContain(pw);
    }
  });
});

describe('parseUsersArgs', () => {
  const env = { ...EMU, DEV_PASSWORD: PASS };
  it('devuelve correo, rol y contraseña del entorno', () => {
    expect(parseUsersArgs(['a@b.mx', 'staff'], env)).toEqual({
      email: 'a@b.mx',
      role: 'staff',
      password: PASS,
    });
  });
  it('normaliza el correo a minúsculas', () => {
    expect(parseUsersArgs(['A@B.mx', 'staff'], env).email).toBe('a@b.mx');
    expect(parseTokenArgs(['A@B.mx'], env).email).toBe('a@b.mx');
  });
  it('falla sin emulador', () => {
    expect(() => parseUsersArgs(['a@b.mx', 'staff'], { DEV_PASSWORD: PASS })).toThrow(/emulador/);
  });
  it('falla con rol inválido o argumentos faltantes', () => {
    expect(() => parseUsersArgs(['a@b.mx', 'admin'], env)).toThrow(/owner/);
    expect(() => parseUsersArgs(['a@b.mx'], env)).toThrow(/Uso/);
    expect(() => parseUsersArgs([], env)).toThrow(/Uso/);
  });
  it('rechaza argumentos de más (p. ej. una contraseña en la línea de comandos)', () => {
    expect(() => parseUsersArgs(['a@b.mx', 'staff', PASS], env)).toThrow(/Uso/);
  });
  it('exige DEV_PASSWORD', () => {
    expect(() => parseUsersArgs(['a@b.mx', 'staff'], EMU)).toThrow(/DEV_PASSWORD/);
  });
});

describe('parseTokenArgs', () => {
  const env = { ...EMU, DEV_PASSWORD: PASS };
  it('devuelve correo y contraseña', () => {
    expect(parseTokenArgs(['a@b.mx'], env)).toEqual({ email: 'a@b.mx', password: PASS });
  });
  it('falla sin emulador, sin correo o con argumentos extra', () => {
    expect(() => parseTokenArgs(['a@b.mx'], { DEV_PASSWORD: PASS })).toThrow(/emulador/);
    expect(() => parseTokenArgs([], env)).toThrow(/Uso/);
    expect(() => parseTokenArgs(['a@b.mx', PASS], env)).toThrow(/Uso/);
  });
});

describe('pickAuthOutputs', () => {
  it('toma UserPoolId y UserPoolClientId', () => {
    expect(pickAuthOutputs({ UserPoolId: 'p', UserPoolClientId: 'c', Otra: 'x' }, 's')).toEqual({
      userPoolId: 'p',
      clientId: 'c',
    });
  });
  it('falla con mensaje claro si falta alguna', () => {
    expect(() => pickAuthOutputs({ UserPoolId: 'p' }, 'canteras-auth-dev')).toThrow(
      /canteras-auth-dev.*UserPoolClientId/,
    );
  });
});

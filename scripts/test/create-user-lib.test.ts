import {
  AdminAddUserToGroupCommand,
  AdminListGroupsForUserCommand,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { describe, expect, it } from 'vitest';

import {
  maskEmail,
  processPromptChunk,
  takePasswordFromEnv,
  parseCreateUserArgs,
  runCreateUser,
  validateNewPassword,
  validateUserEmail,
  validateUserPoolId,
  type CreateUserDeps,
} from '../create-user-lib';

// Centinela: si aparece en CUALQUIER salida, la prueba falla.
const SECRET = 'Sentinela-Secreta-77!x';
const ACCOUNT = '123456789012';
const OTHER_ACCOUNT = '999988887777';
const POOL = 'us-east-1_AbC123xyz';

interface Call {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

interface Harness {
  readonly deps: CreateUserDeps;
  readonly calls: Call[];
  readonly cfnCalls: string[];
  readonly regions: string[];
  readonly prompts: string[];
}

interface Options {
  readonly env?: NodeJS.ProcessEnv;
  readonly isTTY?: boolean;
  readonly account?: string | undefined;
  readonly userExists?: boolean;
  readonly userStatus?: string;
  readonly enabled?: boolean;
  /** Páginas de grupos del usuario existente (cada una con los nombres de esa página). */
  readonly groupPages?: readonly (readonly string[])[];
  readonly password?: string | undefined;
  readonly failOn?: { readonly command: string; readonly error: unknown };
  readonly promptAnswers?: readonly string[];
  readonly stackOutputs?: Record<string, string>;
  readonly stsError?: unknown;
}

function harness(options: Options = {}): Harness {
  const calls: Call[] = [];
  const cfnCalls: string[] = [];
  const regions: string[] = [];
  const prompts: string[] = [];
  const answers = [...(options.promptAnswers ?? [SECRET, SECRET])];
  const deps: CreateUserDeps = {
    env: {
      EXPECTED_AWS_ACCOUNT: ACCOUNT,
      ...options.env,
    },
    password: 'password' in options ? options.password : SECRET,
    isTTY: options.isTTY ?? false,
    promptHidden: (label) => {
      prompts.push(label);
      return Promise.resolve(answers.shift() ?? '');
    },
    getAccountId: () => {
      if (options.stsError !== undefined) return Promise.reject(options.stsError as Error);
      return Promise.resolve('account' in options ? options.account : ACCOUNT);
    },
    getStackOutputs: (stackName) => {
      cfnCalls.push(stackName);
      return Promise.resolve(options.stackOutputs ?? { UserPoolId: POOL });
    },
    cognitoFor: (region) => {
      regions.push(region);
      return {
        send: (command) => {
          const name = command.constructor.name;
          calls.push({ name, input: { ...command.input } as Record<string, unknown> });
          if (options.failOn?.command === name)
            return Promise.reject(options.failOn.error as Error);
          if (command instanceof AdminGetUserCommand) {
            if (options.userExists) {
              return Promise.resolve({
                UserStatus: options.userStatus ?? 'CONFIRMED',
                Enabled: options.enabled ?? true,
              });
            }
            const notFound = Object.assign(new Error('no existe'), {
              name: 'UserNotFoundException',
            });
            return Promise.reject(notFound);
          }
          if (command instanceof AdminListGroupsForUserCommand) {
            const pages = options.groupPages ?? [[]];
            const index =
              command.input.NextToken === undefined ? 0 : Number(command.input.NextToken);
            const page = pages[index] ?? [];
            return Promise.resolve({
              Groups: page.map((GroupName) => ({ GroupName })),
              NextToken: index + 1 < pages.length ? String(index + 1) : undefined,
            });
          }
          return Promise.resolve({});
        },
      };
    },
  };
  return { deps, calls, cfnCalls, regions, prompts };
}

const names = (h: Harness): string[] => h.calls.map((c) => c.name);
/** Llamadas que modifican Cognito (todo salvo la consulta de solo lectura). */
const mutations = (h: Harness): string[] =>
  names(h).filter((n) => n !== 'AdminGetUserCommand' && n !== 'AdminListGroupsForUserCommand');

/** Ejecuta y devuelve TODO lo que el usuario vería (resumen o mensaje de error). */
async function visibleOutput(argv: string[], h: Harness): Promise<string> {
  try {
    return (await runCreateUser(argv, h.deps)).join('\n');
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
}

const awsError = (name: string, message = `fallo ${name} con ${SECRET}`): Error =>
  Object.assign(new Error(message), { name });

describe('parseCreateUserArgs', () => {
  it('toma el correo, rol owner por defecto y sin reset', () => {
    expect(parseCreateUserArgs(['Ana@Dominio.com'])).toEqual({
      email: 'ana@dominio.com',
      role: 'owner',
      resetPassword: false,
    });
  });
  it('acepta rol staff y --reset-password en cualquier posición', () => {
    expect(parseCreateUserArgs(['--reset-password', 'a@b.mx', 'staff'])).toEqual({
      email: 'a@b.mx',
      role: 'staff',
      resetPassword: true,
    });
  });
  it('rechaza --password y explica NEW_USER_PASSWORD sin repetir el valor', () => {
    for (const argv of [
      ['a@b.mx', '--password', SECRET],
      ['a@b.mx', `--password=${SECRET}`],
    ]) {
      let message = '';
      try {
        parseCreateUserArgs(argv);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/no se acepta por argumentos/);
      expect(message).toMatch(/NEW_USER_PASSWORD/);
      expect(message).not.toContain(SECRET);
    }
  });
  it('rechaza banderas desconocidas, argumentos de más y la falta de correo', () => {
    expect(() => parseCreateUserArgs([])).toThrow(/Uso/);
    expect(() => parseCreateUserArgs(['a@b.mx', 'owner', SECRET])).toThrow(/Uso/);
    expect(() => parseCreateUserArgs(['a@b.mx', '--otra'])).toThrow(/Bandera/);
    try {
      parseCreateUserArgs(['a@b.mx', 'owner', SECRET]);
    } catch (error) {
      expect((error as Error).message).not.toContain(SECRET);
    }
  });
  it('rechaza un rol inválido', () => {
    expect(() => parseCreateUserArgs(['a@b.mx', 'admin'])).toThrow(/Rol inválido/);
    expect(() => parseCreateUserArgs(['a@b.mx', 'Owner'])).toThrow(/Rol inválido/);
  });
});

describe('validateUserEmail', () => {
  it('normaliza a minúsculas', () => {
    expect(validateUserEmail('Ana.Perez@Dominio.COM')).toBe('ana.perez@dominio.com');
  });
  it.each([
    '',
    'sin-arroba',
    'a@b',
    'a b@c.mx',
    ' a@b.mx',
    'a@b.mx ',
    'a@@b.mx',
    'a\u0000@b.mx',
    'a\n@b.mx',
    'a\t@b.mx',
    'a\u007f@b.mx',
    'a\u001f@b.mx',
    'a\u0080@b.mx',
    'a\u009f@b.mx',
    'a\u00a0@b.mx',
    '\uff41@b.co',
    'a\u200b@b.mx',
    '\u0130@b.co',
    'a@b.m\u00e9x',
    'a"b@c.mx',
    "a'b@c.mx",
    'a<b@c.mx',
    'a>b@c.mx',
    'a\\b@c.mx',
  ])('rechaza %j', (raw) => {
    expect(() => validateUserEmail(raw)).toThrow(/Correo inválido/);
  });
  it('acepta los extremos del ASCII imprimible permitido (0x21 y 0x7e)', () => {
    expect(validateUserEmail('!~@b.mx')).toBe('!~@b.mx');
  });
  it('rechaza más de 254 caracteres y acepta exactamente 254', () => {
    const domain = '@dominio.com';
    expect(validateUserEmail('a'.repeat(254 - domain.length) + domain)).toHaveLength(254);
    expect(() => validateUserEmail('a'.repeat(255 - domain.length) + domain)).toThrow(
      /Correo inválido/,
    );
  });
});

describe('validateUserPoolId', () => {
  it('acepta el formato de Cognito', () => {
    expect(validateUserPoolId(POOL)).toBe(POOL);
  });
  it.each([
    '',
    'us-east-1',
    'us-east-1_',
    'US-east-1_abc',
    'us-east-1_a b',
    'x_abc',
    'us-east-1_a/b',
  ])('rechaza %j', (raw) => {
    expect(() => validateUserPoolId(raw)).toThrow(/user pool/i);
  });
});

describe('validateNewPassword', () => {
  it('acepta una contraseña que cumple la política', () => {
    expect(validateNewPassword('Abcdefghij1!')).toBe('Abcdefghij1!');
  });
  const cases: [string, string, RegExp][] = [
    ['corta (11)', 'Abcdefghi1!', /12 caracteres/],
    ['sin mayúscula', 'abcdefghij1!', /mayúscula/],
    ['sin minúscula', 'ABCDEFGHIJ1!', /minúscula/],
    ['sin número', 'Abcdefghijk!', /número/],
    ['sin símbolo', 'Abcdefghijk1', /símbolo/],
  ];
  it.each(cases)('rechaza %s sin repetir la contraseña', (_label, pwd, rule) => {
    let message = '';
    try {
      validateNewPassword(pwd);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(rule);
    expect(message).not.toContain(pwd);
  });
});

describe('validateNewPassword: juego de caracteres de Cognito', () => {
  // Símbolos que la doc de Cognito cuenta como especiales (managing-users-passwords).
  const SYMBOLS = '^$*.[]{}()?"!@#%&/\\,><\':;|_~`=+-'.split('');
  it('el listado tiene los 32 símbolos de la doc', () => {
    expect(new Set(SYMBOLS).size).toBe(SYMBOLS.length);
    expect(SYMBOLS).toHaveLength(32);
  });
  it.each(SYMBOLS)('el símbolo %s cuenta como símbolo', (symbol) => {
    const pwd = `Abcdefghij1${symbol}`;
    expect(validateNewPassword(pwd)).toBe(pwd);
  });
  it.each([
    ['ñ', 'Abcdefghij1ñ'],
    ['€', 'Abcdefghij1€'],
    ['emoji', 'Abcdefghij1😀'],
    ['NBSP', 'Abcdefghij1\u00a0'],
    ['tabulador', 'Abcdefghij1!\tx'],
    ['salto de línea', 'Abcdefghij1!\nx'],
    ['espacio inicial', ' Abcdefghij1!'],
    ['espacio final', 'Abcdefghij1! '],
  ])('rechaza %s sin repetir la contraseña', (_label, pwd) => {
    let message = '';
    try {
      validateNewPassword(pwd);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/no permitid|espacio/i);
    expect(message).not.toContain(pwd);
  });
  it('el espacio no inicial ni final es válido pero no cuenta como símbolo', () => {
    expect(validateNewPassword('Abcdef ghij1!')).toBe('Abcdef ghij1!');
    expect(() => validateNewPassword('Abcdef ghij1k')).toThrow(/símbolo/);
  });
  it('acepta 256 caracteres y rechaza 257', () => {
    const base = 'Aa1!';
    expect(validateNewPassword(base + 'x'.repeat(252))).toHaveLength(256);
    expect(() => validateNewPassword(base + 'x'.repeat(253))).toThrow(/256/);
  });
});

describe('maskEmail', () => {
  it('deja solo la primera letra del usuario y el dominio', () => {
    expect(maskEmail('ana.perez@dominio.com')).toBe('a***@dominio.com');
  });
});

describe('guardas de entorno y cuenta', () => {
  it('aborta con AWS_ENDPOINT_URL y remite a dev-users.ts sin llamar a AWS', async () => {
    const h = harness({ env: { AWS_ENDPOINT_URL: 'http://localhost:4566' } });
    await expect(runCreateUser(['a@b.mx'], h.deps)).rejects.toThrow(/dev-users\.ts/);
    expect(h.calls).toEqual([]);
    expect(h.cfnCalls).toEqual([]);
  });
  it('aborta sin EXPECTED_AWS_ACCOUNT', async () => {
    const h = harness({ env: { EXPECTED_AWS_ACCOUNT: '' } });
    await expect(runCreateUser(['a@b.mx'], h.deps)).rejects.toThrow(/Define EXPECTED_AWS_ACCOUNT/);
    expect(h.calls).toEqual([]);
  });
  it('aborta si EXPECTED_AWS_ACCOUNT no tiene 12 dígitos', async () => {
    const h = harness({ env: { EXPECTED_AWS_ACCOUNT: '12345' } });
    await expect(runCreateUser(['a@b.mx'], h.deps)).rejects.toThrow(/12 dígitos/);
  });
  it('aborta si la cuenta real no coincide, sin imprimir ningún ID de cuenta', async () => {
    const h = harness({ account: OTHER_ACCOUNT });
    const out = await visibleOutput(['a@b.mx'], h);
    expect(out).toMatch(/no coincide/);
    expect(out).not.toContain(OTHER_ACCOUNT);
    expect(out).not.toContain(ACCOUNT);
    expect(h.calls).toEqual([]);
    expect(h.cfnCalls).toEqual([]);
  });
  it('aborta si STS no devuelve cuenta o falla, sin filtrar detalles', async () => {
    const sinCuenta = harness({ account: undefined });
    await expect(runCreateUser(['a@b.mx'], sinCuenta.deps)).rejects.toThrow(/cuenta/i);
    const falla = harness({ stsError: new Error(`token ${SECRET}`) });
    const out = await visibleOutput(['a@b.mx'], falla);
    expect(out).not.toContain(SECRET);
    expect(falla.calls).toEqual([]);
  });
  it('prod exige CREATE_USER_CONFIRM=si', async () => {
    const sin = harness({ env: { APP_ENV: 'prod' } });
    await expect(runCreateUser(['a@b.mx'], sin.deps)).rejects.toThrow(/CREATE_USER_CONFIRM/);
    expect(sin.calls).toEqual([]);
    const mal = harness({ env: { APP_ENV: 'prod', CREATE_USER_CONFIRM: 'yes' } });
    await expect(runCreateUser(['a@b.mx'], mal.deps)).rejects.toThrow(/CREATE_USER_CONFIRM/);
    const bien = harness({ env: { APP_ENV: 'prod', CREATE_USER_CONFIRM: 'si' } });
    await runCreateUser(['a@b.mx'], bien.deps);
    expect(bien.cfnCalls).toEqual(['canteras-auth-prod']);
  });
  it('dev no exige CREATE_USER_CONFIRM y usa el stack de dev', async () => {
    const h = harness();
    await runCreateUser(['a@b.mx'], h.deps);
    expect(h.cfnCalls).toEqual(['canteras-auth-dev']);
  });
  it('rechaza un APP_ENV desconocido', async () => {
    const h = harness({ env: { APP_ENV: 'staging' } });
    await expect(runCreateUser(['a@b.mx'], h.deps)).rejects.toThrow(/APP_ENV/);
  });
});

describe('user pool', () => {
  it('USER_POOL_ID evita consultar CloudFormation y define la región del cliente', async () => {
    const h = harness({ env: { USER_POOL_ID: 'eu-west-2_Zz9' } });
    await runCreateUser(['a@b.mx'], h.deps);
    expect(h.cfnCalls).toEqual([]);
    expect(h.regions).toEqual(['eu-west-2']);
    expect(h.calls[0]?.input['UserPoolId']).toBe('eu-west-2_Zz9');
  });
  it('rechaza un USER_POOL_ID inválido', async () => {
    const h = harness({ env: { USER_POOL_ID: 'cualquier-cosa' } });
    await expect(runCreateUser(['a@b.mx'], h.deps)).rejects.toThrow(/user pool/i);
    expect(h.calls).toEqual([]);
  });
  it('rechaza un UserPoolId inválido o ausente en las salidas del stack', async () => {
    const malo = harness({ stackOutputs: { UserPoolId: 'x y' } });
    await expect(runCreateUser(['a@b.mx'], malo.deps)).rejects.toThrow(/user pool/i);
    const ausente = harness({ stackOutputs: {} });
    await expect(runCreateUser(['a@b.mx'], ausente.deps)).rejects.toThrow(/UserPoolId/);
  });
});

describe('contraseña', () => {
  it('aborta sin variable y sin TTY', async () => {
    const h = harness({ password: undefined, isTTY: false });
    await expect(runCreateUser(['a@b.mx'], h.deps)).rejects.toThrow(/NEW_USER_PASSWORD/);
    expect(mutations(h)).toEqual([]);
    expect(h.prompts).toEqual([]);
  });
  it('con TTY y sin variable pide la contraseña dos veces sin eco', async () => {
    const h = harness({ password: undefined, isTTY: true });
    await runCreateUser(['a@b.mx'], h.deps);
    expect(h.prompts).toHaveLength(2);
    const set = h.calls.find((c) => c.name === 'AdminSetUserPasswordCommand');
    expect(set?.input['Password']).toBe(SECRET);
  });
  it('aborta si la confirmación del prompt no coincide, sin repetir nada', async () => {
    const h = harness({
      password: undefined,
      isTTY: true,
      promptAnswers: [SECRET, 'Otra-Distinta-99!'],
    });
    const out = await visibleOutput(['a@b.mx'], h);
    expect(out).toMatch(/no coinciden/);
    expect(out).not.toContain(SECRET);
    expect(mutations(h)).toEqual([]);
  });
  it('con la variable definida no pide nada aunque haya TTY', async () => {
    const h = harness({ isTTY: true });
    await runCreateUser(['a@b.mx'], h.deps);
    expect(h.prompts).toEqual([]);
  });
  it('rechaza una contraseña corta antes de llamar a Cognito', async () => {
    const h = harness({ password: 'Corta1!' });
    const out = await visibleOutput(['a@b.mx'], h);
    expect(out).toMatch(/12 caracteres/);
    expect(out).not.toContain('Corta1!');
    expect(mutations(h)).toEqual([]);
  });
});

describe('flujo de Cognito', () => {
  it('usuario nuevo: GetUser, CreateUser (SUPPRESS), SetPassword permanente y grupo, en ese orden', async () => {
    const h = harness();
    await runCreateUser(['Ana@Dominio.com'], h.deps);
    expect(names(h)).toEqual([
      'AdminGetUserCommand',
      'AdminCreateUserCommand',
      'AdminSetUserPasswordCommand',
      'AdminAddUserToGroupCommand',
    ]);
    expect(h.calls[0]?.input).toEqual({ UserPoolId: POOL, Username: 'ana@dominio.com' });
    expect(h.calls[1]?.input).toMatchObject({
      UserPoolId: POOL,
      Username: 'ana@dominio.com',
      MessageAction: 'SUPPRESS',
      UserAttributes: [
        { Name: 'email', Value: 'ana@dominio.com' },
        { Name: 'email_verified', Value: 'true' },
      ],
    });
    expect(h.calls[2]?.input).toEqual({
      UserPoolId: POOL,
      Username: 'ana@dominio.com',
      Password: SECRET,
      Permanent: true,
    });
    expect(h.calls[3]?.input).toEqual({
      UserPoolId: POOL,
      Username: 'ana@dominio.com',
      GroupName: 'owner',
    });
  });
  it('staff se agrega al grupo staff', async () => {
    const h = harness();
    await runCreateUser(['a@b.mx', 'staff'], h.deps);
    expect(h.calls.at(-1)?.input['GroupName']).toBe('staff');
  });
  it('usuario existente: no toca la contraseña ni lo recrea, pero asegura el grupo', async () => {
    const h = harness({ userExists: true });
    const lines = await runCreateUser(['a@b.mx'], h.deps);
    expect(names(h)).toEqual([
      'AdminGetUserCommand',
      'AdminListGroupsForUserCommand',
      'AdminAddUserToGroupCommand',
    ]);
    expect(lines.join('\n')).toMatch(/ya existía/);
    expect(lines.join('\n')).not.toMatch(/contraseña se cambió/i);
  });
  it('--reset-password en usuario existente cambia la contraseña y avisa', async () => {
    const h = harness({ userExists: true });
    const lines = await runCreateUser(['a@b.mx', '--reset-password'], h.deps);
    expect(names(h)).toEqual([
      'AdminGetUserCommand',
      'AdminListGroupsForUserCommand',
      'AdminSetUserPasswordCommand',
      'AdminAddUserToGroupCommand',
    ]);
    expect(h.calls[2]?.input['Permanent']).toBe(true);
    expect(lines.join('\n')).toMatch(/La contraseña se cambió\./);
  });
  it('un usuario existente sin --reset-password no exige contraseña', async () => {
    const h = harness({ password: undefined, userExists: true });
    await runCreateUser(['a@b.mx'], h.deps);
    expect(names(h)).toEqual([
      'AdminGetUserCommand',
      'AdminListGroupsForUserCommand',
      'AdminAddUserToGroupCommand',
    ]);
  });
  it('no toca el MFA', async () => {
    const h = harness();
    await runCreateUser(['a@b.mx'], h.deps);
    expect(names(h).some((n) => /MFA/i.test(n))).toBe(false);
  });
  it('los comandos son los reales del SDK', () => {
    expect(AdminCreateUserCommand).toBeDefined();
    expect(AdminSetUserPasswordCommand).toBeDefined();
    expect(AdminAddUserToGroupCommand).toBeDefined();
  });
});

describe('resumen', () => {
  it('enmascara el correo, indica rol, estado, nota de MFA y nunca la contraseña', async () => {
    const h = harness();
    const lines = await runCreateUser(['ana.perez@dominio.com', 'staff'], h.deps);
    const text = lines.join('\n');
    expect(text).toContain('✔ Usuario a***@dominio.com listo en el grupo staff (creado).');
    expect(text).toContain(
      'En el primer inicio de sesión, el dashboard te pedirá configurar la app autenticadora (TOTP): el pool exige MFA.',
    );
    expect(text).not.toContain('ana.perez');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(ACCOUNT);
    expect(text).not.toContain(POOL);
  });
});

describe('errores de AWS: mensajes en español, sin filtrar la contraseña', () => {
  const cases: [string, string, RegExp][] = [
    ['InvalidPasswordException', 'AdminSetUserPasswordCommand', /política/],
    ['NotAuthorizedException', 'AdminCreateUserCommand', /permisos/],
    ['ResourceNotFoundException', 'AdminGetUserCommand', /user pool|grupo/i],
    ['LimitExceededException', 'AdminCreateUserCommand', /Demasiadas|límite/i],
    ['TooManyRequestsException', 'AdminAddUserToGroupCommand', /Demasiadas|límite/i],
    ['UsernameExistsException', 'AdminCreateUserCommand', /ya existe/i],
  ];
  it.each(cases)('%s', async (errName, command, rule) => {
    const h = harness({ failOn: { command, error: awsError(errName) } });
    const out = await visibleOutput(['a@b.mx'], h);
    expect(out).toMatch(rule);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain('fallo');
  });
  it('un error inesperado (incluso con la contraseña en el mensaje) no la filtra', async () => {
    for (const command of [
      'AdminGetUserCommand',
      'AdminCreateUserCommand',
      'AdminSetUserPasswordCommand',
      'AdminAddUserToGroupCommand',
    ]) {
      const h = harness({
        failOn: { command, error: new Error(`boom ${SECRET}`) },
      });
      const out = await visibleOutput(['a@b.mx'], h);
      expect(out).not.toContain(SECRET);
      expect(out).toMatch(/inesperado/i);
    }
    const h = harness({ failOn: { command: 'AdminCreateUserCommand', error: SECRET } });
    expect(await visibleOutput(['a@b.mx'], h)).not.toContain(SECRET);
  });
  it('si falla fijar la contraseña tras crear el usuario, indica --reset-password', async () => {
    const h = harness({
      failOn: {
        command: 'AdminSetUserPasswordCommand',
        error: awsError('InvalidPasswordException'),
      },
    });
    const out = await visibleOutput(['a@b.mx'], h);
    expect(out).toMatch(/--reset-password/);
    expect(out).toMatch(/contraseña temporal/);
    expect(out).not.toMatch(/sin contraseña/);
  });
  it('la contraseña no aparece en ninguna salida de éxito', async () => {
    for (const argv of [['a@b.mx'], ['a@b.mx', '--reset-password']]) {
      const h = harness({ userExists: argv.length > 1 });
      expect(await visibleOutput(argv, h)).not.toContain(SECRET);
    }
  });
});

describe('guardas del emulador y de la cuenta (endurecidas)', () => {
  it.each([
    'AWS_ENDPOINT_URL',
    'AWS_ENDPOINT_URL_COGNITO_IDENTITY_PROVIDER',
    'AWS_ENDPOINT_URL_STS',
    'AWS_ENDPOINT_URL_CLOUDFORMATION',
  ])('rechaza %s definida aunque sea cadena vacía, sin imprimir su valor', async (name) => {
    for (const value of ['', 'http://localhost:4566']) {
      const h = harness({ env: { [name]: value } });
      const out = await visibleOutput(['a@b.mx'], h);
      expect(out).toMatch(/dev-users\.ts/);
      expect(out).not.toContain('localhost');
      expect(h.calls).toEqual([]);
      expect(h.cfnCalls).toEqual([]);
    }
  });
  it('rechaza la cuenta del emulador 000000000000', async () => {
    const h = harness({ env: { EXPECTED_AWS_ACCOUNT: '000000000000' }, account: '000000000000' });
    await expect(runCreateUser(['a@b.mx'], h.deps)).rejects.toThrow(/emulador/);
    expect(h.calls).toEqual([]);
  });
  it('compara la cuenta por igualdad estricta, no por inclusión', async () => {
    for (const account of [`0${ACCOUNT}`, `${ACCOUNT}0`, ACCOUNT.slice(1)]) {
      const h = harness({ account });
      await expect(runCreateUser(['a@b.mx'], h.deps)).rejects.toThrow(/no coincide/);
      expect(h.calls).toEqual([]);
    }
  });
  it.each(['1234567890123', '12345678901', 'x123456789012', '123456789012x', '12345678901a'])(
    'EXPECTED_AWS_ACCOUNT %s no es de exactamente 12 dígitos',
    async (value) => {
      const h = harness({ env: { EXPECTED_AWS_ACCOUNT: value }, account: value });
      await expect(runCreateUser(['a@b.mx'], h.deps)).rejects.toThrow(/12 dígitos/);
      expect(h.calls).toEqual([]);
    },
  );
});

describe('usuario existente en mal estado (M1)', () => {
  it.each(['FORCE_CHANGE_PASSWORD', 'RESET_REQUIRED', 'UNCONFIRMED'])(
    'con estado %s falla sin escribir y sugiere --reset-password',
    async (userStatus) => {
      const h = harness({ userExists: true, userStatus });
      const out = await visibleOutput(['a@b.mx'], h);
      expect(out).toContain(`El usuario existe pero no está listo (estado: ${userStatus}).`);
      expect(out).toContain('Vuelve a correr con --reset-password');
      expect(mutations(h)).toEqual([]);
    },
  );
  it('un estado ausente también se trata como no listo', async () => {
    const h = harness({ userExists: true, userStatus: '' });
    await expect(runCreateUser(['a@b.mx'], h.deps)).rejects.toThrow(/no está listo/);
    expect(mutations(h)).toEqual([]);
  });
  it('con --reset-password fija la contraseña permanente y continúa', async () => {
    const h = harness({ userExists: true, userStatus: 'FORCE_CHANGE_PASSWORD' });
    const lines = await runCreateUser(['a@b.mx', '--reset-password'], h.deps);
    expect(mutations(h)).toEqual(['AdminSetUserPasswordCommand', 'AdminAddUserToGroupCommand']);
    expect(lines.join('\n')).toMatch(/La contraseña se cambió\./);
  });
  it('un usuario deshabilitado falla siempre, incluso con --reset-password, sin escribir', async () => {
    for (const argv of [['a@b.mx'], ['a@b.mx', '--reset-password']]) {
      const h = harness({ userExists: true, enabled: false });
      const out = await visibleOutput(argv, h);
      expect(out).toContain('El usuario está deshabilitado');
      expect(out).toContain('AdminEnableUser');
      expect(mutations(h)).toEqual([]);
    }
  });
  it('--reset-password sobre un usuario que no existe aborta sin crearlo (B5)', async () => {
    const h = harness();
    const out = await visibleOutput(['a@b.mx', '--reset-password'], h);
    expect(out).toMatch(/no existe/i);
    expect(mutations(h)).toEqual([]);
    expect(h.prompts).toEqual([]);
  });
});

describe('cambio de rol en silencio (M3)', () => {
  it('aborta si el usuario ya está en OTRO grupo, sin escribir nada', async () => {
    const h = harness({ userExists: true, groupPages: [['staff']] });
    const out = await visibleOutput(['a@b.mx'], h);
    expect(out).toContain('El usuario ya pertenece al grupo staff; no se cambia de rol');
    expect(mutations(h)).toEqual([]);
  });
  it('aborta antes de fijar la contraseña con --reset-password', async () => {
    const h = harness({ userExists: true, groupPages: [['owner']] });
    await expect(runCreateUser(['a@b.mx', 'staff', '--reset-password'], h.deps)).rejects.toThrow(
      /grupo owner/,
    );
    expect(mutations(h)).toEqual([]);
  });
  it('aborta aunque además esté en el grupo pedido', async () => {
    const h = harness({ userExists: true, groupPages: [['owner', 'staff']] });
    await expect(runCreateUser(['a@b.mx'], h.deps)).rejects.toThrow(/grupo staff/);
    expect(mutations(h)).toEqual([]);
  });
  it('es idempotente si ya está en el grupo pedido', async () => {
    const h = harness({ userExists: true, groupPages: [['owner']] });
    await runCreateUser(['a@b.mx'], h.deps);
    expect(mutations(h)).toEqual(['AdminAddUserToGroupCommand']);
  });
  it('sigue la paginación con NextToken y detecta un grupo en la segunda página', async () => {
    const h = harness({ userExists: true, groupPages: [['owner'], ['staff']] });
    await expect(runCreateUser(['a@b.mx'], h.deps)).rejects.toThrow(/grupo staff/);
    const lists = h.calls.filter((c) => c.name === 'AdminListGroupsForUserCommand');
    expect(lists).toHaveLength(2);
    expect(lists[0]?.input['NextToken']).toBeUndefined();
    expect(lists[1]?.input['NextToken']).toBe('1');
    expect(lists[1]?.input).toMatchObject({ UserPoolId: POOL, Username: 'a@b.mx' });
  });
  it('tiene un tope de 10 páginas', async () => {
    const diez = harness({ userExists: true, groupPages: Array.from({ length: 10 }, () => []) });
    await runCreateUser(['a@b.mx'], diez.deps);
    const once = harness({ userExists: true, groupPages: Array.from({ length: 11 }, () => []) });
    await expect(runCreateUser(['a@b.mx'], once.deps)).rejects.toThrow(/páginas/);
    expect(mutations(once)).toEqual([]);
  });
  it('un usuario nuevo no consulta los grupos', async () => {
    const h = harness();
    await runCreateUser(['a@b.mx'], h.deps);
    expect(names(h)).not.toContain('AdminListGroupsForUserCommand');
  });
  it('un error de AWS al listar grupos se traduce sin filtrar la contraseña', async () => {
    const h = harness({
      userExists: true,
      failOn: {
        command: 'AdminListGroupsForUserCommand',
        error: awsError('NotAuthorizedException'),
      },
    });
    const out = await visibleOutput(['a@b.mx'], h);
    expect(out).toMatch(/permisos/);
    expect(out).not.toContain(SECRET);
  });
});

describe('takePasswordFromEnv (B2)', () => {
  it('devuelve la contraseña y la borra del entorno', () => {
    const env: NodeJS.ProcessEnv = { NEW_USER_PASSWORD: SECRET, OTRA: 'x' };
    expect(takePasswordFromEnv(env)).toBe(SECRET);
    expect('NEW_USER_PASSWORD' in env).toBe(false);
    expect(env['OTRA']).toBe('x');
  });
  it('trata la cadena vacía como ausente y también la borra', () => {
    const env: NodeJS.ProcessEnv = { NEW_USER_PASSWORD: '' };
    expect(takePasswordFromEnv(env)).toBeUndefined();
    expect('NEW_USER_PASSWORD' in env).toBe(false);
  });
});

describe('processPromptChunk (B3)', () => {
  it('acumula caracteres y termina con Enter', () => {
    const a = processPromptChunk([], 'ab');
    expect(a).toEqual({ buffer: ['a', 'b'], status: 'continue' });
    expect(processPromptChunk(a.buffer, 'c\r')).toEqual({
      buffer: ['a', 'b', 'c'],
      status: 'done',
    });
    expect(processPromptChunk(['a'], '\n').status).toBe('done');
    expect(processPromptChunk(['a'], '\u0004').status).toBe('done');
  });
  it('acepta un pegado que termina en salto de línea (incluido \\r\\n)', () => {
    expect(processPromptChunk([], 'abc\r\n')).toEqual({ buffer: ['a', 'b', 'c'], status: 'done' });
    expect(processPromptChunk([], 'abc\n').status).toBe('done');
  });
  it('un pegado con texto después del salto de línea es Entrada inválida', () => {
    expect(processPromptChunk([], 'abc\ndef').status).toBe('invalid');
    expect(processPromptChunk([], 'abc\r\ndef').status).toBe('invalid');
  });
  it('Ctrl+C cancela', () => {
    expect(processPromptChunk(['a'], '\u0003').status).toBe('cancel');
  });
  it('ignora Ctrl+Z, ESC y las flechas (secuencias CSI/SS3)', () => {
    expect(processPromptChunk(['a'], '\u001a')).toEqual({ buffer: ['a'], status: 'continue' });
    expect(processPromptChunk(['a'], '\u001b')).toEqual({ buffer: ['a'], status: 'continue' });
    expect(processPromptChunk(['a'], '\u001b[A\u001b[B\u001bOCb')).toEqual({
      buffer: ['a', 'b'],
      status: 'continue',
    });
    expect(processPromptChunk([], '\u001b[3~x')).toEqual({ buffer: ['x'], status: 'continue' });
  });
  it('el retroceso borra un carácter completo, también un emoji', () => {
    expect(processPromptChunk(['a', '😀'], '\u007f')).toEqual({
      buffer: ['a'],
      status: 'continue',
    });
    expect(processPromptChunk(['a', 'b'], '\b').buffer).toEqual(['a']);
    expect(processPromptChunk([], 'a😀\u007f').buffer).toEqual(['a']);
    expect(processPromptChunk([], '\u007f').buffer).toEqual([]);
  });
  it('no modifica el buffer recibido', () => {
    const original = ['a'];
    processPromptChunk(original, 'bc');
    expect(original).toEqual(['a']);
  });
});

export interface DeployEnv {
  name: 'dev' | 'prod';
  account: string | undefined;
  region: string;
}

// Cuenta ficticia que usa el emulador Floci (CLAUDE.md 9.2).
export const FLOCI_ACCOUNT = '000000000000';

export function resolveEnv(env: NodeJS.ProcessEnv = process.env): DeployEnv {
  const rawName = env['APP_ENV'] ?? 'dev';
  if (rawName !== 'dev' && rawName !== 'prod') {
    throw new Error(
      `APP_ENV inválido: "${rawName}". Los únicos valores permitidos son "dev" o "prod".`,
    );
  }
  const name = rawName;

  // Precedencia de región: CDK_DEFAULT_REGION > AWS_REGION > AWS_DEFAULT_REGION > us-east-1.
  const region =
    env['CDK_DEFAULT_REGION'] ?? env['AWS_REGION'] ?? env['AWS_DEFAULT_REGION'] ?? 'us-east-1';

  const explicitAccount = env['CDK_DEFAULT_ACCOUNT'] ?? env['AWS_ACCOUNT_ID'];
  const usesEmulator = Boolean(env['AWS_ENDPOINT_URL']);

  if (name === 'prod') {
    if (usesEmulator) {
      throw new Error(
        'APP_ENV=prod no puede usar AWS_ENDPOINT_URL: nunca se apunta prod a un emulador.',
      );
    }
    if (!explicitAccount) {
      throw new Error(
        'APP_ENV=prod requiere una cuenta explícita (CDK_DEFAULT_ACCOUNT o AWS_ACCOUNT_ID).',
      );
    }
  }

  let account = explicitAccount;
  if (usesEmulator) {
    account ??= FLOCI_ACCOUNT;
    if (account !== FLOCI_ACCOUNT) {
      throw new Error(
        `AWS_ENDPOINT_URL está definido (emulador) pero la cuenta es "${account}". Con Floci la cuenta debe ser ${FLOCI_ACCOUNT}.`,
      );
    }
  } else if (account === FLOCI_ACCOUNT) {
    throw new Error(
      `La cuenta ${FLOCI_ACCOUNT} es solo de Floci y AWS_ENDPOINT_URL no está definido: no se envía a AWS real.`,
    );
  }

  return { name, account, region };
}

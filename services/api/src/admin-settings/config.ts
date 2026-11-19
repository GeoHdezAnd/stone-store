export interface SettingsConfig {
  settingsTable: string;
  auditTable: string;
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new Error(`Falta la variable de entorno ${name}.`);
  }
  return value;
}

/** Lee las 2 variables de entorno; si falta alguna lanza un error claro. */
export function loadConfig(env: Record<string, string | undefined>): SettingsConfig {
  return {
    settingsTable: required(env, 'SETTINGS_TABLE'),
    auditTable: required(env, 'AUDIT_TABLE'),
  };
}

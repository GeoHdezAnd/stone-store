export interface FreightEstimateConfig {
  freightConfig: string;
  stones: string;
  postalCodes: string;
  routeCache: string;
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new Error(`Falta la variable de entorno ${name}.`);
  }
  return value;
}

/** Lee los nombres de las tablas; si falta alguno lanza un error claro al arrancar. */
export function loadConfig(env: Record<string, string | undefined>): FreightEstimateConfig {
  return {
    freightConfig: required(env, 'FREIGHT_CONFIG_TABLE'),
    stones: required(env, 'STONES_TABLE'),
    postalCodes: required(env, 'POSTAL_CODES_TABLE'),
    routeCache: required(env, 'ROUTE_CACHE_TABLE'),
  };
}

/**
 * Lógica pura del seed (sin AWS): lee `content/*.json`, valida con los esquemas de
 * `packages/shared`, comprueba la integridad referencial y arma los items por tabla.
 * La escritura a DynamoDB vive en `seed.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ZodType } from 'zod';

import {
  finishSchema,
  mailSettingsSchema,
  projectSchema,
  publicSettingsSchema,
  serviceSchema,
  SETTINGS_ROW_KEYS,
  stoneSchema,
} from '../packages/shared/src/index';

export interface RawContent {
  stones: unknown;
  finishes: unknown;
  projects: unknown;
  services: unknown;
  settings: unknown;
}

export interface SeedTable {
  /** Nombre lógico; coincide con la salida `<tabla>TableName` del DataStack. */
  table: 'Stones' | 'Projects' | 'Finishes' | 'Services' | 'Settings';
  /** Atributo de clave de partición (se usa en `attribute_not_exists`). */
  key: 'id' | 'key';
  items: Record<string, unknown>[];
}

const FILES: Record<keyof RawContent, string> = {
  stones: 'stones.json',
  finishes: 'finishes.json',
  projects: 'projects.json',
  services: 'services.json',
  settings: 'settings.json',
};

export function readContent(dir: string): RawContent {
  const read = (name: string): unknown => JSON.parse(readFileSync(join(dir, name), 'utf8'));
  return {
    stones: read(FILES.stones),
    finishes: read(FILES.finishes),
    projects: read(FILES.projects),
    services: read(FILES.services),
    settings: read(FILES.settings),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Valida el sobre `{ ejemplo, aviso }` y devuelve el objeto. */
function envelope(file: string, raw: unknown, errors: string[]): Record<string, unknown> | null {
  if (!isObject(raw)) {
    errors.push(`${file}: debe ser un objeto JSON`);
    return null;
  }
  if (typeof raw['ejemplo'] !== 'boolean') {
    errors.push(`${file}: falta el campo booleano "ejemplo" (marca si son datos de ejemplo)`);
  }
  return raw;
}

function parseItems<T extends { id: string }>(
  file: string,
  raw: unknown,
  schema: ZodType<T>,
  errors: string[],
): T[] {
  const env = envelope(file, raw, errors);
  if (!env) return [];
  const list = env['items'];
  if (!Array.isArray(list)) {
    errors.push(`${file}: "items" debe ser una lista`);
    return [];
  }
  const parsed: T[] = [];
  const seen = new Set<string>();
  list.forEach((item: unknown, i) => {
    const result = schema.safeParse(item);
    if (!result.success) {
      for (const issue of result.error.issues) {
        errors.push(`${file}[${i}].${issue.path.join('.')}: ${issue.message}`);
      }
      return;
    }
    if (seen.has(result.data.id)) errors.push(`${file}: id repetido "${result.data.id}"`);
    seen.add(result.data.id);
    parsed.push(result.data);
  });
  return parsed;
}

export class SeedValidationError extends Error {
  public constructor(public readonly errors: readonly string[]) {
    super(`El contenido de ejemplo no es válido:\n- ${errors.join('\n- ')}`);
    this.name = 'SeedValidationError';
  }
}

/** Valida todo el contenido y arma los items. Lanza `SeedValidationError` si algo falla. */
export function buildSeedPlan(raw: RawContent): SeedTable[] {
  const errors: string[] = [];

  const stones = parseItems(FILES.stones, raw.stones, stoneSchema, errors);
  const finishes = parseItems(FILES.finishes, raw.finishes, finishSchema, errors);
  const projects = parseItems(FILES.projects, raw.projects, projectSchema, errors);
  const services = parseItems(FILES.services, raw.services, serviceSchema, errors);

  const settingsEnv = envelope(FILES.settings, raw.settings, errors);
  const pub = publicSettingsSchema.safeParse(settingsEnv?.['public']);
  const mail = mailSettingsSchema.safeParse(settingsEnv?.['mail']);
  if (settingsEnv && !pub.success) {
    for (const i of pub.error.issues)
      errors.push(`settings.json.public.${i.path.join('.')}: ${i.message}`);
  }
  if (settingsEnv && !mail.success) {
    for (const i of mail.error.issues)
      errors.push(`settings.json.mail.${i.path.join('.')}: ${i.message}`);
  }

  // Integridad referencial. Las piedras guardan los acabados por NOMBRE; los proyectos por id.
  const stoneIds = new Set(stones.map((s) => s.id));
  const finishIds = new Set(finishes.map((f) => f.id));
  const finishNames = new Set(finishes.map((f) => f.nombre));
  const projectIds = new Set(projects.map((p) => p.id));
  for (const s of stones) {
    for (const a of s.acabados) {
      if (!finishNames.has(a)) errors.push(`Piedra "${s.id}": el acabado "${a}" no existe`);
    }
    for (const p of s.proyectosRelacionados) {
      if (!projectIds.has(p)) errors.push(`Piedra "${s.id}": el proyecto "${p}" no existe`);
    }
  }
  for (const p of projects) {
    for (const s of p.piedras) {
      if (!stoneIds.has(s)) errors.push(`Proyecto "${p.id}": la piedra "${s}" no existe`);
    }
    for (const a of p.acabados) {
      if (!finishIds.has(a)) errors.push(`Proyecto "${p.id}": el acabado "${a}" no existe`);
    }
  }

  if (errors.length > 0 || !pub.success || !mail.success) throw new SeedValidationError(errors);

  return [
    { table: 'Stones', key: 'id', items: stones },
    { table: 'Projects', key: 'id', items: projects },
    { table: 'Finishes', key: 'id', items: finishes },
    { table: 'Services', key: 'id', items: services },
    {
      table: 'Settings',
      key: 'key',
      items: [
        { key: SETTINGS_ROW_KEYS.public, ...pub.data },
        { key: SETTINGS_ROW_KEYS.mail, ...mail.data },
      ],
    },
  ];
}

/**
 * Lógica pura del relleno de variantes de imagen (`media-backfill.ts`): fotos subidas ANTES de
 * desplegar la Lambda `MediaVariants` (o cuyo evento se perdió) no tienen sus 3 variantes WebP.
 * Reutiliza `createVariantsHandler` de `services/api/src/media-variants` (mismas validaciones, mismos
 * límites y mismas claves vía `variantKey`): aquí NO se duplica la lógica de imagen.
 */
import { MEDIA_VARIANT_WIDTHS, isProcessableOriginalKey, variantKey } from '@canteras/shared';
import type { S3Event } from 'aws-lambda';

import { createLogger } from '../services/api/src/lib/logger';
import {
  createVariantsHandler,
  partialKey,
  type ObjectStore,
} from '../services/api/src/media-variants/process-event';
import type { ImageProcessor } from '../services/api/src/media-variants/processor';
import { checkSeedEnv } from './seed-freight-lib';

export interface StoredObject {
  key: string;
  size: number;
}

/**
 * Salvaguardas de entorno: las del seed (APP_ENV, confirmación de prod, sin emulador en prod) más una
 * propia de este script: con emulador (Floci) solo valen las credenciales de prueba `test`, nunca
 * credenciales reales ni un perfil de AWS (CLAUDE.md 9.2).
 */
export function checkBackfillEnv(env: Record<string, string | undefined>): 'dev' | 'prod' {
  const appEnv = checkSeedEnv(env);
  if (env['AWS_ENDPOINT_URL']) {
    if (env['AWS_ACCESS_KEY_ID'] !== 'test') {
      throw new Error(
        'Con AWS_ENDPOINT_URL (Floci) solo se admiten las credenciales de prueba (AWS_ACCESS_KEY_ID=test): nunca credenciales reales. Abortado.',
      );
    }
    if (env['AWS_PROFILE']) {
      throw new Error('Con AWS_ENDPOINT_URL (Floci) no se admite AWS_PROFILE. Abortado.');
    }
  }
  return appEnv;
}

/** Dry-run por defecto: solo `--apply` escribe. */
export function parseBackfillArgs(argv: readonly string[]): { apply: boolean } {
  let apply = false;
  let dry = false;
  for (const arg of argv) {
    if (arg === '--apply') apply = true;
    else if (arg === '--dry-run') dry = true;
    else throw new Error(`Argumento desconocido: ${arg}. Usa --dry-run (por defecto) o --apply.`);
  }
  if (apply && dry) throw new Error('No combines --apply con --dry-run: elige uno.');
  return { apply };
}

export interface BackfillPlan {
  originals: number;
  complete: number;
  pending: StoredObject[];
}

/** Originales procesables sin las 3 variantes (según las claves existentes en el bucket). */
export function planBackfill(objects: readonly StoredObject[]): BackfillPlan {
  const keys = new Set(objects.map((o) => o.key));
  const pending: StoredObject[] = [];
  let originals = 0;
  let complete = 0;
  for (const obj of objects) {
    if (!isProcessableOriginalKey(obj.key)) continue;
    originals += 1;
    if (MEDIA_VARIANT_WIDTHS.every((w) => keys.has(variantKey(obj.key, w)))) complete += 1;
    else pending.push(obj);
  }
  return { originals, complete, pending };
}

export interface BackfillReport {
  originals: number;
  complete: number;
  pending: number;
  created: number;
  rejected: number;
  failed: number;
  /** Pistas parciales (carpeta + cola corta) de los casos que merecen atención. Sin PII. */
  hints: string[];
}

export interface BackfillDeps {
  bucket: string;
  store: ObjectStore;
  processor: ImageProcessor;
  apply: boolean;
}

const MAX_HINTS = 10;

export async function runBackfill(
  deps: BackfillDeps,
  objects: readonly StoredObject[],
): Promise<BackfillReport> {
  const plan = planBackfill(objects);
  const report: BackfillReport = {
    originals: plan.originals,
    complete: plan.complete,
    pending: plan.pending.length,
    created: 0,
    rejected: 0,
    failed: 0,
    hints: [],
  };
  const hint = (h: string): void => {
    if (report.hints.length < MAX_HINTS) report.hints.push(h);
  };

  if (!deps.apply) {
    for (const obj of plan.pending) hint(partialKey(obj.key));
    return report;
  }

  // Se cuenta lo que el propio handler registra (`variants_created` / `image_rejected`).
  const logger = createLogger({}, (line) => {
    const entry = JSON.parse(line) as { msg?: string };
    if (entry.msg === 'variants_created') report.created += 1;
    else if (entry.msg === 'image_rejected') report.rejected += 1;
  });
  const handler = createVariantsHandler({
    bucket: deps.bucket,
    store: deps.store,
    processor: deps.processor,
    logger,
  });

  for (const obj of plan.pending) {
    const event = {
      Records: [
        {
          eventName: 'ObjectCreated:Put',
          s3: {
            bucket: { name: deps.bucket },
            object: { key: encodeURIComponent(obj.key).replace(/%2F/g, '/'), size: obj.size },
          },
        },
      ],
    } as unknown as S3Event;
    const before = report.created;
    const beforeRejected = report.rejected;
    try {
      await handler(event);
    } catch {
      report.failed += 1;
      hint(partialKey(obj.key));
      continue;
    }
    if (report.created === before && report.rejected === beforeRejected) report.failed += 1;
    if (report.rejected > beforeRejected) hint(partialKey(obj.key));
  }
  return report;
}

/** Resumen en español: solo cifras y pistas parciales (sin claves completas ni datos personales). */
export function formatBackfillReport(r: BackfillReport, applied: boolean): string {
  const lines = [
    applied
      ? 'Relleno de variantes: aplicado.'
      : 'Relleno de variantes: SIMULACIÓN (no se escribió nada).',
    `  Originales encontrados: ${r.originals}`,
    `  Ya completos (3 variantes): ${r.complete}`,
    `  Pendientes: ${r.pending}`,
  ];
  if (applied) {
    lines.push(
      `  Creadas: ${r.created}`,
      `  Rechazadas (imagen inválida): ${r.rejected}`,
      `  Fallidas (reintentar): ${r.failed}`,
    );
  } else if (r.pending > 0) {
    lines.push('  Para generarlas ejecuta de nuevo con --apply.');
  }
  if (r.hints.length > 0) lines.push(`  Pistas: ${r.hints.join(', ')}`);
  return lines.join('\n');
}

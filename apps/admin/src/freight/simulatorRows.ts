import { parseFreightSimulateRequest } from '@canteras/shared';
import type { Stone } from '@canteras/shared';
import type { SimulateItem, SimulateRequest } from '../api/freightApi';

/** Un renglón del simulador, todo como texto (así se edita). */
export interface SimRow {
  stoneId: string;
  unidad: string;
  cantidad: string;
  espesor: string;
}

export const blankRow = (): SimRow => ({ stoneId: '', unidad: '', cantidad: '', espesor: '' });

/** Al cambiar de piedra se reinician unidad y espesor (dependen de la piedra). */
export function withStone(row: SimRow, stoneId: string, stones: readonly Stone[]): SimRow {
  const stone = stones.find((s) => s.id === stoneId);
  const unidad = stone?.vendidaPor[0] ?? '';
  return { ...row, stoneId, unidad, espesor: defaultThickness(stone, unidad) };
}

/** Al cambiar de unidad se reinicia el espesor (solo aplica a m²). */
export function withUnit(row: SimRow, unidad: string, stones: readonly Stone[]): SimRow {
  const stone = stones.find((s) => s.id === row.stoneId);
  return { ...row, unidad, espesor: defaultThickness(stone, unidad) };
}

function defaultThickness(stone: Stone | undefined, unidad: string): string {
  if (!stone || unidad !== 'm2') return '';
  return stone.espesoresCm.length === 1 ? String(stone.espesoresCm[0]) : '';
}

export interface SimulatorInput {
  codigoPostal: string;
  distanciaKm: string;
  rows: readonly SimRow[];
  version: string;
  skipZoneCheck: boolean;
}

/** Arma y valida la petición; devuelve mensajes en español si algo falta. */
export function buildSimulateRequest(
  input: SimulatorInput,
): { ok: true; request: SimulateRequest } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const cp = input.codigoPostal.trim();
  if (cp === '' && !input.skipZoneCheck) {
    errors.push('Captura el código postal (o activa «Omitir validación de zona»).');
  }
  if (input.distanciaKm.trim() === '' || Number.isNaN(Number(input.distanciaKm))) {
    errors.push('Captura la distancia en km (un número).');
  }
  const items: SimulateItem[] = input.rows.map((r) => ({
    stoneId: r.stoneId,
    cantidad: r.cantidad.trim() === '' ? Number.NaN : Number(r.cantidad),
    unidad: r.unidad as SimulateItem['unidad'],
    ...(r.espesor === '' ? {} : { espesorCm: Number(r.espesor) }),
  }));
  if (errors.length > 0) return { ok: false, errors };

  const parsed = parseFreightSimulateRequest({
    ...(cp === '' ? {} : { codigoPostal: cp }),
    distanciaKm: Number(input.distanciaKm),
    items,
  });
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  return {
    ok: true,
    request: {
      ...parsed.data,
      ...(input.version === '' ? {} : { version: input.version }),
      ...(input.skipZoneCheck ? { skipZoneCheck: true } : {}),
    } as SimulateRequest,
  };
}

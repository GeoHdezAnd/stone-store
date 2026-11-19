// Datos de EJEMPLO solo para pruebas (proyecto académico): nada de esto es real.
import { stoneSchema, type Stone } from '../catalog/stone';
import type { FreightConfigInput } from './config';

const baseStone = {
  id: 'arenisca',
  nombre: 'Arenisca',
  origen: 'Sedimentaria',
  tipoRoca: 'Roca sedimentaria',
  colores: ['Beige'],
  usos: ['Fachada'],
  categoriasUso: ['fachadas'],
  acabados: ['Labrado'],
  formatos: ['Bloque'],
  espesoresCm: [3, 5, 8],
  absorcionPct: 4.2,
  descripcion: 'Piedra de ejemplo.',
  existencia: 'En patio',
  entregaDias: 7,
  vendidaPor: ['m2', 'pieza', 'tonelada'],
  pesoKgPorM2PorCm: 22,
  pesoKgPorPieza: 35,
  densidadKgM3: 2200,
  fotos: [],
  proyectosRelacionados: [],
  activa: true,
};

export function makeStone(patch: Record<string, unknown> = {}): Stone {
  return stoneSchema.parse({ ...baseStone, ...patch });
}

export const arenisca = makeStone();
export const caliza = makeStone({
  id: 'caliza',
  nombre: 'Caliza',
  espesoresCm: [2, 3, 5],
  vendidaPor: ['m2', 'tonelada'],
  pesoKgPorPieza: null,
  pesoKgPorM2PorCm: null,
  densidadKgM3: 2400,
});
export const inactiva = makeStone({ id: 'travertino', nombre: 'Travertino', activa: false });
export const stones: readonly Stone[] = [arenisca, caliza, inactiva];

/** Config de ejemplo: merma 0 y sin ida y vuelta para que las cuentas a mano sean exactas. */
export function makeConfigInput(patch: Record<string, unknown> = {}): FreightConfigInput {
  return {
    version: 'v1',
    ejemplo: true,
    origen: { lat: 19.1, lng: -97.62, nombre: 'Patio (ejemplo)' },
    camiones: [
      {
        id: 'camioneta',
        nombre: 'Camioneta',
        capacidadKg: 3500,
        base: 800,
        porKm: 12,
        minimo: 1500,
      },
      { id: 'torton', nombre: 'Torton', capacidadKg: 12000, base: 2000, porKm: 22, minimo: 3500 },
      { id: 'trailer', nombre: 'Tráiler', capacidadKg: 25000, base: 3500, porKm: 30, minimo: 6000 },
    ],
    margenRango: 0.1,
    recargoDescarga: 500,
    mermaPct: 0,
    zonasCubiertas: ['72', '73', '74', '90', '91', '01', '06'],
    maxKm: 350,
    creadaPor: 'tests',
    creadaAt: '2026-11-19T12:00:00.000Z',
    resumenCambio: 'Tarifas de ejemplo',
    ...patch,
  } as FreightConfigInput;
}

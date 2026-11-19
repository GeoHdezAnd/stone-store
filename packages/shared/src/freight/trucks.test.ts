import { describe, expect, it } from 'vitest';
import { freightConfigSchema } from './config';
import { pickTrucks } from './trucks';
import { makeConfigInput } from './test-fixtures';

const cfg = freightConfigSchema.parse(makeConfigInput());

describe('pickTrucks', () => {
  it('elige el camión de menor costo que cubre el peso', () => {
    // 62 km: camioneta 1544, torton 3500, tráiler 6000.
    const r = pickTrucks(110, 62, cfg);
    expect(r.camion.id).toBe('camioneta');
    expect(r.viajes).toBe(1);
    expect(r.costoViajeCentavos).toBe(154_400);
  });

  it('peso == capacidad cabe en un viaje; un gramo más pasa al siguiente camión', () => {
    expect(pickTrucks(3500, 62, cfg).camion.id).toBe('camioneta');
    expect(pickTrucks(3500.01, 62, cfg).camion.id).toBe('torton');
    expect(pickTrucks(25000, 62, cfg)).toMatchObject({ viajes: 1 });
  });

  it('si el camión más barato en km largos no es el más chico, elige por costo', () => {
    const c = freightConfigSchema.parse(
      makeConfigInput({
        camiones: [
          { id: 'a', nombre: 'A', capacidadKg: 1000, base: 5000, porKm: 50, minimo: 1000 },
          { id: 'b', nombre: 'B', capacidadKg: 2000, base: 1000, porKm: 10, minimo: 1000 },
        ],
      }),
    );
    expect(pickTrucks(500, 100, c).camion.id).toBe('b');
  });

  it('empate de costo: gana el de menor capacidad', () => {
    const c = freightConfigSchema.parse(
      makeConfigInput({
        camiones: [
          { id: 'grande', nombre: 'G', capacidadKg: 2000, base: 1000, porKm: 10, minimo: 1000 },
          { id: 'chico', nombre: 'C', capacidadKg: 1000, base: 1000, porKm: 10, minimo: 1000 },
        ],
      }),
    );
    expect(pickTrucks(500, 10, c).camion.id).toBe('chico');
  });

  it('si excede al mayor, divide en viajes del camión más grande', () => {
    const r = pickTrucks(60000, 62, cfg);
    expect(r.camion.id).toBe('trailer');
    expect(r.viajes).toBe(3);
    expect(pickTrucks(50000, 62, cfg).viajes).toBe(2);
    expect(pickTrucks(50000.01, 62, cfg).viajes).toBe(3);
  });

  it('aplica el mínimo del camión cuando base + km queda por debajo', () => {
    // torton a 10 km: 2000 + 220 = 2220 < 3500
    const r = pickTrucks(5000, 10, cfg);
    expect(r.camion.id).toBe('torton');
    expect(r.costoViajeCentavos).toBe(350_000);
  });

  it('calcula en centavos enteros (sin errores de coma flotante)', () => {
    const c = freightConfigSchema.parse(
      makeConfigInput({
        camiones: [
          { id: 'a', nombre: 'A', capacidadKg: 1000, base: 0.1, porKm: 0.2, minimo: 0.01 },
        ],
      }),
    );
    // 0.1 + 3 × 0.2 = 0.7 (en flotante daría 0.7000000000000001)
    expect(pickTrucks(1, 3, c).costoViajeCentavos).toBe(70);
  });

  it('empate en la capacidad máxima: viajes del camión más barato, no del primero de la lista', () => {
    const mk = (primero: 'x' | 'y') => {
      const x = { id: 'x', nombre: 'X', capacidadKg: 25000, base: 0, porKm: 1, minimo: 9000 };
      const y = { id: 'y', nombre: 'Y', capacidadKg: 25000, base: 0, porKm: 1, minimo: 6000 };
      return freightConfigSchema.parse(
        makeConfigInput({ camiones: primero === 'x' ? [x, y] : [y, x] }),
      );
    };
    for (const orden of ['x', 'y'] as const) {
      const r = pickTrucks(30000, 10, mk(orden));
      expect(r.camion.id).toBe('y');
      expect(r.viajes).toBe(2);
      expect(r.costoViajeCentavos).toBe(600_000);
    }
  });
});

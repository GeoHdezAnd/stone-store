import { describe, expect, it } from 'vitest';
import {
  QUOTE_STATUSES,
  canRoleTransition,
  canTransition,
  isFinalStatus,
  rolesForTransition,
  type QuoteStatus,
} from './quote-status';

// Matriz esperada: solo estas parejas (origen -> destino) son válidas.
const PERMITIDAS: ReadonlyArray<readonly [QuoteStatus, QuoteStatus]> = [
  ['nueva', 'en_revision'],
  ['nueva', 'cancelada'],
  ['en_revision', 'cotizada'],
  ['en_revision', 'cancelada'],
  ['cotizada', 'en_revision'],
  ['cotizada', 'enviada'],
  ['cotizada', 'cancelada'],
  ['enviada', 'ganada'],
  ['enviada', 'perdida'],
  ['enviada', 'cancelada'],
];
// Las que puede hacer staff (preparación de la cotización).
const STAFF: ReadonlyArray<readonly [QuoteStatus, QuoteStatus]> = [
  ['nueva', 'en_revision'],
  ['en_revision', 'cotizada'],
  ['cotizada', 'en_revision'],
];

describe('canTransition', () => {
  it('cubre los 7 estados', () => {
    expect(QUOTE_STATUSES).toHaveLength(7);
  });

  describe('matriz completa 7x7', () => {
    for (const from of QUOTE_STATUSES) {
      for (const to of QUOTE_STATUSES) {
        const esperado = PERMITIDAS.some(([f, t]) => f === from && t === to);
        it(`${from} -> ${to} es ${esperado}`, () => {
          expect(canTransition(from, to)).toBe(esperado);
        });
      }
    }
  });

  it('rechaza cualquier auto-transición', () => {
    for (const s of QUOTE_STATUSES) expect(canTransition(s, s)).toBe(false);
  });

  it('ganada, perdida y cancelada son finales', () => {
    for (const s of ['ganada', 'perdida', 'cancelada'] as const) {
      expect(isFinalStatus(s)).toBe(true);
      for (const t of QUOTE_STATUSES) expect(canTransition(s, t)).toBe(false);
    }
    expect(isFinalStatus('enviada')).toBe(false);
  });

  it('devuelve false con entradas desconocidas o sin validar, sin lanzar errores', () => {
    const basura: unknown[] = [
      'inexistente',
      '',
      undefined,
      null,
      42,
      {},
      [],
      'toString',
      '__proto__',
    ];
    for (const x of basura) {
      expect(canTransition(x, 'nueva')).toBe(false);
      expect(canTransition('nueva', x)).toBe(false);
      expect(canTransition(x, x)).toBe(false);
    }
  });
});

describe('roles por transición', () => {
  for (const from of QUOTE_STATUSES) {
    for (const to of QUOTE_STATUSES) {
      const valida = PERMITIDAS.some(([f, t]) => f === from && t === to);
      const staff = STAFF.some(([f, t]) => f === from && t === to);
      it(`${from} -> ${to}: owner=${valida}, staff=${staff}`, () => {
        expect(canRoleTransition('owner', from, to)).toBe(valida);
        expect(canRoleTransition('staff', from, to)).toBe(staff);
        expect(rolesForTransition(from, to)).toEqual(
          valida ? (staff ? ['owner', 'staff'] : ['owner']) : [],
        );
      });
    }
  }

  it('entradas desconocidas no dan permiso a nadie', () => {
    expect(rolesForTransition('x', 'nueva')).toEqual([]);
    expect(canRoleTransition('admin' as never, 'nueva', 'en_revision')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { QUOTE_STATUSES, canTransition, type QuoteStatus } from './quote-status';

// Matriz esperada: solo estas parejas (origen -> destino) son válidas.
const PERMITIDAS: ReadonlyArray<readonly [QuoteStatus, QuoteStatus]> = [
  ['nueva', 'en_revision'],
  ['en_revision', 'cotizada'],
  ['cotizada', 'enviada'],
  ['enviada', 'ganada'],
  ['enviada', 'perdida'],
  ['enviada', 'cancelada'],
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

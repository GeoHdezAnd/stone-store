import { describe, expect, it } from 'vitest';
import {
  LOST_REASONS,
  MAX_HISTORY,
  MAX_NOTES,
  noteBodySchema,
  patchBodySchema,
  quoteSchema,
  SEND_LOCK_TTL_MS,
  sendBodySchema,
  stripStorageKeys,
} from '../schema';
import { sampleQuote } from './test-fixtures';

describe('quoteSchema', () => {
  it('acepta una solicitud válida', () => {
    expect(quoteSchema.safeParse(sampleQuote()).success).toBe(true);
  });

  it('es estricto: rechaza campos extra', () => {
    expect(quoteSchema.safeParse({ ...sampleQuote(), extra: 1 }).success).toBe(false);
    expect(quoteSchema.safeParse({ ...sampleQuote(), searchKey: 'x' }).success).toBe(false);
  });

  it.each([
    ['quoteId no ULID', { quoteId: 'abc' }],
    ['folio mal formado', { folio: 'CN-26-1' }],
    ['rev 0', { rev: 0 }],
    ['rev decimal', { rev: 1.5 }],
    ['status inválido', { status: 'otro' }],
    ['fecha sin milisegundos', { createdAt: '2026-11-19T10:00:00Z' }],
    ['lostReason inválido', { lostReason: 'x' }],
    ['items vacío', { items: [] }],
  ])('rechaza %s', (_n, over) => {
    expect(quoteSchema.safeParse({ ...sampleQuote(), ...over }).success).toBe(false);
  });

  it('rechaza piedras repetidas en items', () => {
    const q = sampleQuote();
    const dup = { ...q, items: [q.items[0]!, q.items[0]!] };
    expect(quoteSchema.safeParse(dup).success).toBe(false);
  });

  it('rechaza correo y CP inválidos', () => {
    const q = sampleQuote();
    expect(quoteSchema.safeParse({ ...q, customer: { ...q.customer, correo: 'x' } }).success).toBe(
      false,
    );
    expect(
      quoteSchema.safeParse({ ...q, works: { ...q.works, codigoPostal: '7281' } }).success,
    ).toBe(false);
  });

  it('rechaza dinero con más de 2 decimales o negativo', () => {
    const q = sampleQuote();
    const fq = q.finalQuote!;
    expect(quoteSchema.safeParse({ ...q, finalQuote: { ...fq, total: 1.005 } }).success).toBe(
      false,
    );
    expect(quoteSchema.safeParse({ ...q, finalQuote: { ...fq, fleteFinal: -1 } }).success).toBe(
      false,
    );
  });

  it('limita historial y notas', () => {
    const h = { at: '2026-11-19T10:00:00.000Z', by: 'u', tipo: 'nota' as const };
    expect(
      quoteSchema.safeParse({ ...sampleQuote(), history: Array(MAX_HISTORY + 1).fill(h) }).success,
    ).toBe(false);
    const n = { at: '2026-11-19T10:00:00.000Z', by: 'u', texto: 'x' };
    expect(
      quoteSchema.safeParse({ ...sampleQuote(), notes: Array(MAX_NOTES + 1).fill(n) }).success,
    ).toBe(false);
  });

  it('LOST_REASONS tiene los 6 motivos', () => {
    expect([...LOST_REASONS]).toEqual([
      'precio_piedra',
      'precio_flete',
      'tiempo_entrega',
      'otro_proveedor',
      'sin_respuesta',
      'otro',
    ]);
  });
});

describe('patchBodySchema', () => {
  const fq = { items: [{ stoneId: 'arenisca', precioUnitario: 100 }], fleteFinal: 0 };
  it('exige rev', () => {
    expect(patchBodySchema.safeParse({ status: 'en_revision' }).success).toBe(false);
    expect(patchBodySchema.safeParse({ status: 'en_revision', rev: 1 }).success).toBe(true);
  });
  it('exige al menos un cambio', () => {
    expect(patchBodySchema.safeParse({ rev: 1 }).success).toBe(false);
  });
  it('rechaza enviada y nueva por PATCH', () => {
    expect(patchBodySchema.safeParse({ status: 'enviada', rev: 1 }).success).toBe(false);
    expect(patchBodySchema.safeParse({ status: 'nueva', rev: 1 }).success).toBe(false);
  });
  it('perdida exige lostReason y lostReason solo con perdida', () => {
    expect(patchBodySchema.safeParse({ status: 'perdida', rev: 1 }).success).toBe(false);
    expect(
      patchBodySchema.safeParse({ status: 'perdida', lostReason: 'otro', rev: 1 }).success,
    ).toBe(true);
    expect(
      patchBodySchema.safeParse({ status: 'cancelada', lostReason: 'otro', rev: 1 }).success,
    ).toBe(false);
    expect(patchBodySchema.safeParse({ lostReason: 'otro', rev: 1 }).success).toBe(false);
  });
  it('cotizada exige finalQuote', () => {
    expect(patchBodySchema.safeParse({ status: 'cotizada', rev: 1 }).success).toBe(false);
    expect(patchBodySchema.safeParse({ status: 'cotizada', finalQuote: fq, rev: 1 }).success).toBe(
      true,
    );
  });
  it('vigenciaDias por defecto 15 y acotada', () => {
    const r = patchBodySchema.safeParse({ finalQuote: fq, rev: 1 });
    expect(r.success && r.data.finalQuote?.vigenciaDias).toBe(15);
    expect(
      patchBodySchema.safeParse({ finalQuote: { ...fq, vigenciaDias: 0 }, rev: 1 }).success,
    ).toBe(false);
  });
  it('el cliente NUNCA envía subtotales ni total', () => {
    expect(patchBodySchema.safeParse({ finalQuote: { ...fq, total: 1 }, rev: 1 }).success).toBe(
      false,
    );
    expect(
      patchBodySchema.safeParse({
        finalQuote: { ...fq, items: [{ stoneId: 'a', precioUnitario: 1, subtotal: 1 }] },
        rev: 1,
      }).success,
    ).toBe(false);
  });
  it('flete negativo, precio negativo o duplicado se rechazan', () => {
    expect(
      patchBodySchema.safeParse({ finalQuote: { ...fq, fleteFinal: -1 }, rev: 1 }).success,
    ).toBe(false);
    expect(
      patchBodySchema.safeParse({
        finalQuote: { ...fq, items: [{ stoneId: 'a', precioUnitario: -1 }] },
        rev: 1,
      }).success,
    ).toBe(false);
    const dup = { stoneId: 'a', precioUnitario: 1 };
    expect(
      patchBodySchema.safeParse({ finalQuote: { ...fq, items: [dup, dup] }, rev: 1 }).success,
    ).toBe(false);
  });
});

describe('noteBodySchema', () => {
  it('texto 1..2000 y rev obligatoria', () => {
    expect(noteBodySchema.safeParse({ texto: 'hola', rev: 1 }).success).toBe(true);
    expect(noteBodySchema.safeParse({ texto: '', rev: 1 }).success).toBe(false);
    expect(noteBodySchema.safeParse({ texto: 'x'.repeat(2000), rev: 1 }).success).toBe(true);
    expect(noteBodySchema.safeParse({ texto: 'x'.repeat(2001), rev: 1 }).success).toBe(false);
    expect(noteBodySchema.safeParse({ texto: 'hola' }).success).toBe(false);
  });
});

describe('stripStorageKeys', () => {
  it('quita las claves de índice y searchKey', () => {
    const raw = {
      ...sampleQuote(),
      gsi1pk: 'a',
      gsi1sk: 'b',
      gsi2pk: 'c',
      gsi2sk: 'd',
      searchKey: 'e',
    };
    expect(quoteSchema.safeParse(stripStorageKeys(raw)).success).toBe(true);
  });
});

describe('sendLock (candado de envío, lo gestiona SOLO el servidor)', () => {
  it('el esquema lo acepta opcional con at y by, estricto', () => {
    const q = sampleQuote();
    expect(
      quoteSchema.safeParse({ ...q, sendLock: { at: '2026-11-19T10:00:00.000Z', by: 'u' } })
        .success,
    ).toBe(true);
    expect(quoteSchema.safeParse({ ...q, sendLock: { at: 'x', by: 'u' } }).success).toBe(false);
    expect(
      quoteSchema.safeParse({ ...q, sendLock: { at: '2026-11-19T10:00:00.000Z', by: 'u', x: 1 } })
        .success,
    ).toBe(false);
  });
  it('el cliente nunca lo manda: PATCH, notas y envío lo rechazan', () => {
    const lock = { at: '2026-11-19T10:00:00.000Z', by: 'u' };
    expect(
      patchBodySchema.safeParse({ status: 'en_revision', rev: 1, sendLock: lock }).success,
    ).toBe(false);
    expect(noteBodySchema.safeParse({ texto: 'x', rev: 1, sendLock: lock }).success).toBe(false);
    expect(sendBodySchema.safeParse({ rev: 1, sendLock: lock }).success).toBe(false);
  });
  it('SEND_LOCK_TTL_MS es de 5 minutos', () => {
    expect(SEND_LOCK_TTL_MS).toBe(300_000);
  });
});

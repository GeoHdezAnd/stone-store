import { describe, expect, it } from 'vitest';
import { buildAuditEntry } from '../audit';

const base = {
  entityType: 'stone',
  entityId: 'arenisca',
  userId: 'sub-123',
  action: 'update',
  before: { a: 1 },
  after: { a: 2 },
  at: new Date('2026-11-18T10:00:00.123Z'),
  requestId: 'req-abc',
} as const;

describe('buildAuditEntry', () => {
  it('arma el ítem de AuditLog', () => {
    expect(buildAuditEntry(base)).toEqual({
      pk: 'ENTITY#stone#arenisca',
      sk: '2026-11-18T10:00:00.123Z#req-abc',
      userId: 'sub-123',
      accion: 'update',
      antes: { a: 1 },
      despues: { a: 2 },
    });
  });

  it('permite antes/después nulos (alta y baja)', () => {
    const e = buildAuditEntry({ ...base, action: 'create', before: null });
    expect(e.antes).toBeNull();
    const d = buildAuditEntry({ ...base, action: 'delete', after: null });
    expect(d.despues).toBeNull();
  });

  it.each(['create', 'update', 'delete', 'publish', 'revert', 'send', 'status', 'invite'])(
    'acepta la acción %s',
    (action) => {
      expect(buildAuditEntry({ ...base, action }).accion).toBe(action);
    },
  );

  it.each([
    ['entityType', 'Stone'],
    ['entityType', ''],
    ['entityType', '1stone'],
    ['entityType', 'a'.repeat(33)],
    ['entityType', 'a#b'],
    ['entityId', ''],
    ['entityId', 'a#b'],
    ['entityId', 'a/b'],
    ['entityId', '../x'],
    ['entityId', 'con espacio'],
    ['userId', ''],
    ['userId', '   '],
    ['action', 'drop'],
    ['action', ''],
    ['requestId', ''],
    ['requestId', 'a#b'],
  ])('rechaza %s inválido: %j', (field, value) => {
    expect(() => buildAuditEntry({ ...base, [field]: value })).toThrow();
  });

  it('rechaza una fecha inválida', () => {
    expect(() => buildAuditEntry({ ...base, at: new Date('nope') })).toThrow(/fecha/i);
  });

  it('rechaza ítems de más de ~300 KB con un error claro', () => {
    const big = { blob: 'x'.repeat(310_000) };
    expect(() => buildAuditEntry({ ...base, after: big })).toThrow(/KB/);
  });

  it('sin scope no agrega el atributo (el ítem no entra al índice disperso)', () => {
    expect('scope' in buildAuditEntry(base)).toBe(false);
  });

  it('con scope CATALOG lo agrega (entra al índice de cambios pendientes)', () => {
    expect(buildAuditEntry({ ...base, scope: 'CATALOG' }).scope).toBe('CATALOG');
  });

  it('rechaza un scope desconocido', () => {
    expect(() => buildAuditEntry({ ...base, scope: 'OTRO' as 'CATALOG' })).toThrow(/scope/);
  });
});

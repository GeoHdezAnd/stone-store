import { describe, expect, it } from 'vitest';
import { ROLES, hasAnyRole, isRole, parseGroupsClaim, rolesFromGroups } from '../index';

describe('isRole / ROLES', () => {
  it('solo reconoce owner y staff exactos', () => {
    expect(ROLES).toEqual(['owner', 'staff']);
    expect(isRole('owner')).toBe(true);
    expect(isRole('staff')).toBe(true);
  });

  it.each(['OWNER', 'Staff', 'owner ', 'xowner', '', 'constructor', '__proto__', 'toString'])(
    'rechaza %j',
    (x) => {
      expect(isRole(x)).toBe(false);
    },
  );

  it.each([undefined, null, 1, {}, [], ['owner'], true])('rechaza el valor no cadena %j', (x) => {
    expect(isRole(x)).toBe(false);
  });
});

describe('parseGroupsClaim', () => {
  it.each([
    ['[owner]', ['owner']],
    ['[owner staff]', ['owner', 'staff']],
    ['[owner, staff]', ['owner,', 'staff']],
    ['[owner,staff]', ['owner,staff']],
    ['[x,owner]', ['x,owner']],
    ['[a,owner b]', ['a,owner', 'b']],
    ['["owner"]', ['"owner"']],
    ["['owner']", ["'owner'"]],
    ['  [ owner   staff ]  ', ['owner', 'staff']],
    ['owner', ['owner']],
    ['owner staff', ['owner', 'staff']],
    ['owner,staff', ['owner,staff']],
    ['[owner owner]', ['owner']],
    ['[owner-solo-lectura]', ['owner-solo-lectura']],
    ['[OWNER]', ['OWNER']],
    [
      ['owner', 'staff'],
      ['owner', 'staff'],
    ],
    [
      ['owner', 'owner', '', ' staff '],
      ['owner', 'staff'],
    ],
    [
      ['owner', 1, null, {}, 'staff'],
      ['owner', 'staff'],
    ],
    ['[__proto__ constructor]', ['__proto__', 'constructor']],
  ])('%j -> %j', (raw, expected) => {
    expect(parseGroupsClaim(raw)).toEqual(expected);
  });

  it.each([
    undefined,
    null,
    0,
    1,
    NaN,
    true,
    false,
    {},
    { owner: true },
    '',
    '   ',
    '[]',
    '[ ]',
    () => 1,
    Symbol('x'),
  ])('devuelve [] para %j', (raw) => {
    expect(parseGroupsClaim(raw)).toEqual([]);
  });

  it.each(['[x,owner]', '[a,owner b]', '["owner"]', '[owner,staff]'])(
    'la coma/comillas no fabrican un rol: %s',
    (raw) => {
      expect(rolesFromGroups(parseGroupsClaim(raw))).toEqual([]);
    },
  );

  it('no lanza con arreglos raros ni objetos hostiles', () => {
    const hostile = {
      toString() {
        throw new Error('boom');
      },
    };
    expect(() => parseGroupsClaim(hostile)).not.toThrow();
    expect(parseGroupsClaim([hostile, 'owner'])).toEqual(['owner']);
  });
});

describe('rolesFromGroups', () => {
  it.each([
    [['owner'], ['owner']],
    [
      ['owner', 'staff'],
      ['owner', 'staff'],
    ],
    [['staff', 'staff'], ['staff']],
    [['owner-solo-lectura'], []],
    [['OWNER', 'Staff'], []],
    [['xowner', 'staff2', 'owner '], []],
    [['__proto__', 'constructor', 'toString', 'hasOwnProperty'], []],
    [[], []],
  ])('%j -> %j', (groups, expected) => {
    expect(rolesFromGroups(groups)).toEqual(expected);
  });
});

describe('hasAnyRole', () => {
  it.each([
    [['owner'], ['owner'], true],
    [['staff'], ['staff'], true],
    [['owner'], ['staff'], false],
    [['staff'], ['owner'], false],
    [['owner'], ['owner', 'staff'], true],
    [['staff'], ['owner', 'staff'], true],
    [['owner', 'staff'], ['owner'], true],
    [[], ['owner', 'staff'], false],
  ] as const)('usuario %j, permitidos %j -> %s', (user, allowed, expected) => {
    expect(hasAnyRole(user, allowed)).toBe(expected);
  });

  it('sin jerarquía: owner no satisface una ruta solo para staff', () => {
    expect(hasAnyRole(['owner'], ['staff'])).toBe(false);
  });

  it('falla cerrado si la lista de permitidos viene vacía en ejecución', () => {
    expect(hasAnyRole(['owner'], [] as unknown as ['owner'])).toBe(false);
  });
});

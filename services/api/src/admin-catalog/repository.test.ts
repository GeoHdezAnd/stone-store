import { describe, expect, it } from 'vitest';
import type { AuditEntry } from '../lib/audit';
import { stone } from './fixtures';
import {
  AlreadyExistsError,
  ConflictError,
  DynamoCatalogRepository,
  NotFoundError,
} from './repository';

const tables = {
  stone: 't-stones',
  project: 't-projects',
  finish: 't-finishes',
  service: 't-services',
} as const;

const audit: AuditEntry = {
  pk: 'ENTITY#stone#arenisca',
  sk: '2026-11-18T10:00:00.000Z#req-1',
  userId: 'user-1',
  accion: 'create',
  antes: null,
  despues: { id: 'arenisca' },
};

interface Captured {
  name: string;
  input: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** Cliente falso: captura cada comando y responde con `respond`. */
function fakeClient(respond: (c: Captured) => unknown = () => ({})) {
  const commands: Captured[] = [];
  return {
    commands,
    client: {
      send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
        const c = { name: cmd.constructor.name, input: cmd.input } as Captured;
        commands.push(c);
        const out = respond(c);
        if (out instanceof Error) throw out;
        return out;
      },
    },
  };
}

function cancelled(...codes: string[]): Error {
  return Object.assign(new Error('cancelada'), {
    name: 'TransactionCanceledException',
    CancellationReasons: codes.map((Code) => ({ Code })),
  });
}

const repoWith = (client: ReturnType<typeof fakeClient>['client']) =>
  new DynamoCatalogRepository(client, tables, 't-audit', { sleep: async () => {} });

describe('DynamoCatalogRepository: escrituras', () => {
  it('create: transacción con EXACTAMENTE 2 Put y sus condiciones', async () => {
    const f = fakeClient();
    const item = stone();
    await repoWith(f.client).create('stone', item, audit);
    expect(f.commands).toHaveLength(1);
    expect(f.commands[0]?.name).toBe('TransactWriteCommand');
    const items = f.commands[0]?.input['TransactItems'];
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      Put: {
        TableName: 't-stones',
        Item: item,
        ConditionExpression: 'attribute_not_exists(id)',
      },
    });
    expect(items[1]).toEqual({
      Put: {
        TableName: 't-audit',
        Item: audit,
        ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
      },
    });
  });

  it('replace: Put con attribute_exists(id) + auditoría', async () => {
    const f = fakeClient();
    await repoWith(f.client).replace('stone', stone(), audit);
    const items = f.commands[0]?.input['TransactItems'];
    expect(items).toHaveLength(2);
    expect(items[0].Put.ConditionExpression).toBe('attribute_exists(id)');
    expect(items[0].Put.TableName).toBe('t-stones');
    expect(items[1].Put.TableName).toBe('t-audit');
    expect(items[1].Put.ConditionExpression).toBe(
      'attribute_not_exists(pk) AND attribute_not_exists(sk)',
    );
  });

  it('softDelete: Update activa=false con attribute_exists(id); jamás un Delete', async () => {
    const f = fakeClient();
    await repoWith(f.client).softDelete('project', 'casa', audit);
    const items = f.commands[0]?.input['TransactItems'];
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      Update: {
        TableName: 't-projects',
        Key: { id: 'casa' },
        UpdateExpression: 'SET activa = :f',
        ConditionExpression: 'attribute_exists(id)',
        ExpressionAttributeValues: { ':f': false },
      },
    });
    expect(items[1].Put.TableName).toBe('t-audit');
    for (const c of f.commands) {
      expect(c.name).not.toMatch(/Delete/);
      for (const i of c.input['TransactItems'] ?? [])
        expect(Object.keys(i)).not.toContain('Delete');
    }
  });

  it('create: cancelación con ConditionalCheckFailed en la entidad -> AlreadyExists', async () => {
    const f = fakeClient(() => cancelled('ConditionalCheckFailed', 'None'));
    await expect(repoWith(f.client).create('stone', stone(), audit)).rejects.toBeInstanceOf(
      AlreadyExistsError,
    );
  });

  it('replace y softDelete: ConditionalCheckFailed en la entidad -> NotFound', async () => {
    const f = fakeClient(() => cancelled('ConditionalCheckFailed', 'None'));
    const repo = repoWith(f.client);
    await expect(repo.replace('stone', stone(), audit)).rejects.toBeInstanceOf(NotFoundError);
    await expect(repo.softDelete('stone', 'arenisca', audit)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('auditoría duplicada (índice 1) NO es "ya existe": se propaga el error original', async () => {
    const err = cancelled('None', 'ConditionalCheckFailed');
    const f = fakeClient(() => err);
    const repo = repoWith(f.client);
    for (const op of [
      () => repo.create('stone', stone(), audit),
      () => repo.replace('stone', stone(), audit),
      () => repo.softDelete('stone', 'arenisca', audit),
    ]) {
      const e = await op().catch((x: unknown) => x);
      expect(e).toBe(err);
      expect(e).not.toBeInstanceOf(AlreadyExistsError);
      expect(e).not.toBeInstanceOf(NotFoundError);
    }
  });

  it('otros motivos de cancelación y otros errores se propagan', async () => {
    for (const err of [
      cancelled('ThrottlingError', 'ThrottlingError'),
      new Error('boom'),
      Object.assign(new Error('sin motivos'), { name: 'TransactionCanceledException' }),
    ]) {
      const f = fakeClient(() => err);
      await expect(repoWith(f.client).create('stone', stone(), audit)).rejects.toBe(err);
    }
  });
});

describe('DynamoCatalogRepository: lecturas', () => {
  it('get: GetCommand con Key {id} y lectura consistente', async () => {
    const f = fakeClient(() => ({ Item: { id: 'a' } }));
    expect(await repoWith(f.client).get('finish', 'a')).toEqual({ id: 'a' });
    expect(f.commands[0]?.name).toBe('GetCommand');
    expect(f.commands[0]?.input).toMatchObject({
      TableName: 't-finishes',
      Key: { id: 'a' },
      ConsistentRead: true,
    });
  });

  it('get: sin Item devuelve null', async () => {
    const f = fakeClient(() => ({}));
    expect(await repoWith(f.client).get('finish', 'a')).toBeNull();
  });

  it('list: Scan con Limit y ExclusiveStartKey solo si hay cursor', async () => {
    const f = fakeClient(() => ({ Items: [{ id: 'a' }], LastEvaluatedKey: { id: 'a' } }));
    const repo = repoWith(f.client);
    const p1 = await repo.list('service', { limit: 10 });
    expect(p1).toEqual({ items: [{ id: 'a' }], lastKey: { id: 'a' } });
    expect(f.commands[0]?.name).toBe('ScanCommand');
    expect(f.commands[0]?.input).toEqual({
      TableName: 't-services',
      Limit: 10,
      ConsistentRead: true,
    });
    await repo.list('service', { limit: 10, exclusiveStartKey: { id: 'z' } });
    expect(f.commands[1]?.input['ExclusiveStartKey']).toEqual({ id: 'z' });
  });

  it('list: sin LastEvaluatedKey la última página no trae cursor', async () => {
    const f = fakeClient(() => ({ Items: [{ id: 'a' }] }));
    expect((await repoWith(f.client).list('service', { limit: 5 })).lastKey).toBeNull();
  });

  it('list: un LastEvaluatedKey con forma inesperada es un error', async () => {
    const f = fakeClient(() => ({ Items: [], LastEvaluatedKey: { id: 5 } }));
    await expect(repoWith(f.client).list('service', { limit: 5 })).rejects.toThrow();
  });
});

describe('DynamoCatalogRepository: existsAll', () => {
  const batchClient = (existing: Set<string>, unprocessedRounds = 0) => {
    let rounds = unprocessedRounds;
    return fakeClient((c) => {
      const req = c.input['RequestItems']['t-stones'];
      const keys: { id: string }[] = req.Keys;
      if (rounds > 0 && keys.length > 0) {
        rounds -= 1;
        const [first, ...rest] = keys;
        return {
          Responses: {
            't-stones': rest.filter((k) => existing.has(k.id)).map((k) => ({ id: k.id })),
          },
          UnprocessedKeys: { 't-stones': { ...req, Keys: [first] } },
        };
      }
      return {
        Responses: {
          't-stones': keys.filter((k) => existing.has(k.id)).map((k) => ({ id: k.id })),
        },
        UnprocessedKeys: {},
      };
    });
  };

  it('sin ids no llama a DynamoDB', async () => {
    const f = batchClient(new Set());
    expect(await repoWith(f.client).existsAll('stone', [])).toEqual([]);
    expect(f.commands).toHaveLength(0);
  });

  it('trocea en lotes de <=100, deduplica y pide solo la clave', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `s${i}`);
    const f = batchClient(new Set(ids));
    const missing = await repoWith(f.client).existsAll('stone', [...ids, 's0', 's1']);
    expect(missing).toEqual([]);
    expect(f.commands.map((c) => c.name)).toEqual(Array(3).fill('BatchGetCommand'));
    expect(f.commands.map((c) => c.input['RequestItems']['t-stones'].Keys.length)).toEqual([
      100, 100, 50,
    ]);
    const req = f.commands[0]?.input['RequestItems']['t-stones'];
    expect(req.ProjectionExpression).toBe('#id');
    expect(req.ExpressionAttributeNames).toEqual({ '#id': 'id' });
    expect(req.ConsistentRead).toBe(true);
  });

  it('devuelve los ids que no existen', async () => {
    const f = batchClient(new Set(['a']));
    expect(await repoWith(f.client).existsAll('stone', ['a', 'b', 'c'])).toEqual(['b', 'c']);
  });

  it('reintenta UnprocessedKeys y no los da por inexistentes', async () => {
    const f = batchClient(new Set(['a', 'b', 'c']), 2);
    expect(await repoWith(f.client).existsAll('stone', ['a', 'b', 'c'])).toEqual([]);
    expect(f.commands.length).toBeGreaterThan(1);
  });

  it('si UnprocessedKeys no se resuelve tras los reintentos, falla claro', async () => {
    const f = batchClient(new Set(['a', 'b']), 1000);
    await expect(repoWith(f.client).existsAll('stone', ['a', 'b'])).rejects.toThrow(
      /UnprocessedKeys/,
    );
  });
});

describe('DynamoCatalogRepository: huecos de mutación', () => {
  const repo = () => repoWith(fakeClient().client);
  const run = async (op: (r: DynamoCatalogRepository) => Promise<void>) => {
    const f = fakeClient();
    await op(repoWith(f.client));
    return f.commands[0]?.input['TransactItems'];
  };

  it('softDelete exige attribute_exists(id): sin ella un Update crearía un ítem fantasma solo con activa', async () => {
    const items = await run((r) => r.softDelete('stone', 'arenisca', audit));
    expect(items[0].Update.ConditionExpression).toBe('attribute_exists(id)');
    expect(items[0].Update.UpdateExpression).toBe('SET activa = :f');
    expect(items[0].Update.ExpressionAttributeValues).toEqual({ ':f': false });
    expect(items[0].Update.Key).toEqual({ id: 'arenisca' });
  });

  it('replace: el Put completo (tabla, ítem, condición) va primero y la auditoría segundo', async () => {
    const item = stone();
    const items = await run((r) => r.replace('stone', item, audit));
    expect(items[0]).toEqual({
      Put: { TableName: 't-stones', Item: item, ConditionExpression: 'attribute_exists(id)' },
    });
    expect(Object.keys(items[1])).toEqual(['Put']);
    expect(items[1].Put.Item).toEqual(audit);
  });

  it('cada operación usa la tabla de su entidad', async () => {
    for (const e of ['stone', 'project', 'finish', 'service'] as const) {
      const items = await run((r) => r.create(e, stone(), audit));
      expect(items[0].Put.TableName).toBe(tables[e]);
      const del = await run((r) => r.softDelete(e, 'x', audit));
      expect(del[0].Update.TableName).toBe(tables[e]);
    }
  });

  it('list y get usan la tabla correcta y existsAll envía la clave {id}', async () => {
    const f = fakeClient(() => ({ Items: [], Responses: {} }));
    const r = repoWith(f.client);
    await r.list('project', { limit: 1 });
    await r.get('project', 'a');
    await r.existsAll('project', ['a']);
    expect(f.commands[0]?.input['TableName']).toBe('t-projects');
    expect(f.commands[1]?.input['TableName']).toBe('t-projects');
    expect(f.commands[2]?.input['RequestItems']['t-projects'].Keys).toEqual([{ id: 'a' }]);
    void repo;
  });
});

describe('DynamoCatalogRepository: TransactionConflict', () => {
  it.each([
    ['índice 0', ['TransactionConflict', 'None']],
    ['índice 1', ['None', 'TransactionConflict']],
  ])('un TransactionConflict en el %s se traduce a ConflictError', async (_n, codes) => {
    const f = fakeClient(() => cancelled(...codes));
    const r = repoWith(f.client);
    await expect(r.create('stone', stone(), audit)).rejects.toBeInstanceOf(ConflictError);
    await expect(r.replace('stone', stone(), audit)).rejects.toBeInstanceOf(ConflictError);
    await expect(r.softDelete('stone', 'a', audit)).rejects.toBeInstanceOf(ConflictError);
  });
});

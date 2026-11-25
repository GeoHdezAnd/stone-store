import { BatchGetCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { DynamoFreightEstimateRepository } from '../repository';

const TABLES = {
  freightConfig: 'FreightConfig',
  stones: 'Stones',
  postalCodes: 'PostalCodes',
  routeCache: 'RouteCache',
};

type Handler = (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => unknown;

function setup(handler: Handler = () => ({})) {
  const commands: { name: string; input: Record<string, unknown>; cmd: unknown }[] = [];
  const client = {
    send: async (cmd: unknown) => {
      const c = cmd as { constructor: { name: string }; input: Record<string, unknown> };
      commands.push({ name: c.constructor.name, input: c.input, cmd });
      const out = handler(c);
      if (out instanceof Error) throw out;
      return out;
    },
  };
  const repo = new DynamoFreightEstimateRepository(client, TABLES, {
    sleep: async () => undefined,
  });
  return { repo, commands };
}

describe('getActiveFreightRow', () => {
  it('lee el puntero ACTIVE y luego la versión activa, ambas consistentes', async () => {
    const row = { version: 't0002' };
    const { repo, commands } = setup((c) =>
      (c.input['Key'] as { version: string }).version === 'ACTIVE'
        ? { Item: { version: 'ACTIVE', activeVersion: 't0002', latestVersion: 't0003' } }
        : { Item: row },
    );
    expect(await repo.getActiveFreightRow()).toEqual(row);
    expect(commands.map((c) => c.input)).toEqual([
      { TableName: 'FreightConfig', Key: { version: 'ACTIVE' }, ConsistentRead: true },
      { TableName: 'FreightConfig', Key: { version: 't0002' }, ConsistentRead: true },
    ]);
    expect(commands.every((c) => c.cmd instanceof GetCommand)).toBe(true);
  });

  it('sin puntero, o con una versión que no tiene la forma tNNNN: null sin leer más', async () => {
    const sin = setup(() => ({}));
    expect(await sin.repo.getActiveFreightRow()).toBeNull();
    expect(sin.commands).toHaveLength(1);
    for (const activeVersion of ['../x', 'ACTIVE', 5, undefined, 't1']) {
      const { repo, commands } = setup(() => ({ Item: { version: 'ACTIVE', activeVersion } }));
      expect(await repo.getActiveFreightRow(), String(activeVersion)).toBeNull();
      expect(commands).toHaveLength(1);
    }
  });
});

describe('getStones', () => {
  it('BatchGet de ids únicos en la tabla Stones, consistente', async () => {
    const { repo, commands } = setup(() => ({ Responses: { Stones: [{ id: 'a' }, { id: 'b' }] } }));
    expect(await repo.getStones(['a', 'b', 'a'])).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.cmd).toBeInstanceOf(BatchGetCommand);
    expect(commands[0]!.input).toEqual({
      RequestItems: { Stones: { Keys: [{ id: 'a' }, { id: 'b' }], ConsistentRead: true } },
    });
  });

  it('reintenta las UnprocessedKeys', async () => {
    let n = 0;
    const { repo, commands } = setup(() =>
      n++ === 0
        ? {
            Responses: { Stones: [{ id: 'a' }] },
            UnprocessedKeys: { Stones: { Keys: [{ id: 'b' }] } },
          }
        : { Responses: { Stones: [{ id: 'b' }] } },
    );
    expect(await repo.getStones(['a', 'b'])).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(commands).toHaveLength(2);
  });

  it('si siempre quedan claves sin procesar, falla (no se cicla)', async () => {
    const { repo } = setup(() => ({ UnprocessedKeys: { Stones: { Keys: [{ id: 'a' }] } } }));
    await expect(repo.getStones(['a'])).rejects.toThrow(/UnprocessedKeys/);
  });

  it('sin ids no llama a AWS', async () => {
    const { repo, commands } = setup();
    expect(await repo.getStones([])).toEqual([]);
    expect(commands).toHaveLength(0);
  });
});

describe('getPostalCode y getRouteCache', () => {
  it('GetItem por `cp` en su tabla; ausente = null', async () => {
    const { repo, commands } = setup((c) =>
      c.input['TableName'] === 'PostalCodes' ? { Item: { cp: '72810' } } : {},
    );
    expect(await repo.getPostalCode('72810')).toEqual({ cp: '72810' });
    expect(await repo.getRouteCache('72810')).toBeNull();
    expect(commands.map((c) => [c.input['TableName'], c.input['Key']])).toEqual([
      ['PostalCodes', { cp: '72810' }],
      ['RouteCache', { cp: '72810' }],
    ]);
  });
});

describe('putRouteCache', () => {
  it('PutItem en RouteCache', async () => {
    const { repo, commands } = setup();
    const item = { cp: '72810', distanciaKm: 62, ttl: 1 };
    await repo.putRouteCache(item);
    expect(commands[0]!.cmd).toBeInstanceOf(PutCommand);
    expect(commands[0]!.input).toEqual({ TableName: 'RouteCache', Item: item });
  });
});

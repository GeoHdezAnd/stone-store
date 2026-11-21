import { BatchGetCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import {
  DuplicateQuoteError,
  DynamoQuotesCreateRepository,
  FolioExhaustedError,
} from './repository';

const TABLES = {
  quotes: 'Quotes',
  counters: 'Counters',
  stones: 'Stones',
  freightConfig: 'FreightConfig',
  settings: 'Settings',
};

type Handler = (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => unknown;

function setup(handler: Handler = () => ({})) {
  const commands: { name: string; input: Record<string, unknown> }[] = [];
  const client = {
    send: async (cmd: unknown) => {
      const c = cmd as { constructor: { name: string }; input: Record<string, unknown> };
      commands.push({ name: c.constructor.name, input: c.input });
      const out = handler(c);
      if (out instanceof Error) throw out;
      return out;
    },
  };
  const repo = new DynamoQuotesCreateRepository(client, TABLES, { sleep: async () => undefined });
  return { repo, commands };
}

const named = (name: string, message = name): Error => Object.assign(new Error(message), { name });

describe('getActiveFreightRow', () => {
  it('lee el puntero ACTIVE y luego la versión activa, ambas consistentes', async () => {
    const row = { version: 't0002', mermaPct: 5 };
    const { repo, commands } = setup((c) =>
      (c.input['Key'] as { version: string }).version === 'ACTIVE'
        ? { Item: { version: 'ACTIVE', activeVersion: 't0002', latestVersion: 't0003' } }
        : { Item: row },
    );
    expect(await repo.getActiveFreightRow()).toEqual(row);
    expect(commands).toEqual([
      {
        name: 'GetCommand',
        input: { TableName: 'FreightConfig', Key: { version: 'ACTIVE' }, ConsistentRead: true },
      },
      {
        name: 'GetCommand',
        input: { TableName: 'FreightConfig', Key: { version: 't0002' }, ConsistentRead: true },
      },
    ]);
    expect(new GetCommand(commands[0]!.input as never)).toBeInstanceOf(GetCommand);
  });

  it('sin puntero: null y no pide nada más', async () => {
    const { repo, commands } = setup(() => ({}));
    expect(await repo.getActiveFreightRow()).toBeNull();
    expect(commands).toHaveLength(1);
  });

  it('puntero con versión inválida (no es tNNNN): null, sin leer esa clave', async () => {
    for (const activeVersion of ['ACTIVE', '../x', 5, undefined, 't1']) {
      const { repo, commands } = setup(() => ({ Item: { version: 'ACTIVE', activeVersion } }));
      expect(await repo.getActiveFreightRow(), String(activeVersion)).toBeNull();
      expect(commands).toHaveLength(1);
    }
  });

  it('versión activa inexistente: null', async () => {
    const { repo } = setup((c) =>
      (c.input['Key'] as { version: string }).version === 'ACTIVE'
        ? { Item: { version: 'ACTIVE', activeVersion: 't0002' } }
        : {},
    );
    expect(await repo.getActiveFreightRow()).toBeNull();
  });
});

describe('getPublicSettings', () => {
  it('lee SOLO la fila PUBLIC, consistente', async () => {
    const { repo, commands } = setup(() => ({ Item: { key: 'PUBLIC', nombrePatio: 'x' } }));
    expect(await repo.getPublicSettings()).toEqual({ key: 'PUBLIC', nombrePatio: 'x' });
    expect(commands).toEqual([
      {
        name: 'GetCommand',
        input: { TableName: 'Settings', Key: { key: 'PUBLIC' }, ConsistentRead: true },
      },
    ]);
  });

  it('sin fila: null', async () => {
    expect(await setup(() => ({})).repo.getPublicSettings()).toBeNull();
  });
});

describe('getStones', () => {
  it('BatchGetItem exacto, sin repetir ids y consistente', async () => {
    const { repo, commands } = setup(() => ({
      Responses: { Stones: [{ id: 'a' }, { id: 'b' }] },
    }));
    expect(await repo.getStones(['a', 'b', 'a'])).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(commands).toEqual([
      {
        name: 'BatchGetCommand',
        input: {
          RequestItems: { Stones: { Keys: [{ id: 'a' }, { id: 'b' }], ConsistentRead: true } },
        },
      },
    ]);
    expect(new BatchGetCommand(commands[0]!.input as never)).toBeInstanceOf(BatchGetCommand);
  });

  it('sin ids no llama a DynamoDB', async () => {
    const { repo, commands } = setup();
    expect(await repo.getStones([])).toEqual([]);
    expect(commands).toHaveLength(0);
  });

  it('reintenta las UnprocessedKeys', async () => {
    let n = 0;
    const { repo, commands } = setup(() => {
      n++;
      return n === 1
        ? {
            Responses: { Stones: [{ id: 'a' }] },
            UnprocessedKeys: { Stones: { Keys: [{ id: 'b' }] } },
          }
        : { Responses: { Stones: [{ id: 'b' }] } };
    });
    expect(await repo.getStones(['a', 'b'])).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(commands).toHaveLength(2);
    expect(
      (commands[1]!.input['RequestItems'] as { Stones: { Keys: unknown } }).Stones.Keys,
    ).toEqual([{ id: 'b' }]);
  });

  it('si las UnprocessedKeys no se resuelven tras 5 intentos, lanza', async () => {
    const { repo } = setup(() => ({
      Responses: {},
      UnprocessedKeys: { Stones: { Keys: [{ id: 'a' }] } },
    }));
    await expect(repo.getStones(['a'])).rejects.toThrow(/UnprocessedKeys/);
  });
});

describe('reserveFolioNumber', () => {
  it('ADD atómico exacto en `folio#<año>` con tope y devuelve el valor nuevo', async () => {
    const { repo, commands } = setup(() => ({ Attributes: { value: 42 } }));
    expect(await repo.reserveFolioNumber(2026)).toBe(42);
    expect(commands).toEqual([
      {
        name: 'UpdateCommand',
        input: {
          TableName: 'Counters',
          Key: { name: 'folio#2026' },
          UpdateExpression: 'ADD #v :n',
          ConditionExpression: 'attribute_not_exists(#v) OR #v < :max',
          ExpressionAttributeNames: { '#v': 'value' },
          ExpressionAttributeValues: { ':n': 1, ':max': 99999 },
          ReturnValues: 'UPDATED_NEW',
        },
      },
    ]);
    expect(new UpdateCommand(commands[0]!.input as never)).toBeInstanceOf(UpdateCommand);
  });

  it('contador agotado (condición fallida): FolioExhaustedError', async () => {
    const { repo } = setup(() => named('ConditionalCheckFailedException'));
    await expect(repo.reserveFolioNumber(2026)).rejects.toBeInstanceOf(FolioExhaustedError);
  });

  it('otros errores se propagan tal cual', async () => {
    const { repo } = setup(() => named('ProvisionedThroughputExceededException'));
    await expect(repo.reserveFolioNumber(2026)).rejects.toMatchObject({
      name: 'ProvisionedThroughputExceededException',
    });
  });

  it.each([undefined, '5', 0, -1, 1.5, Number.NaN])(
    'un contador devuelto inválido (%s) lanza',
    async (value) => {
      const { repo } = setup(() => ({ Attributes: { value } }));
      await expect(repo.reserveFolioNumber(2026)).rejects.toThrow();
    },
  );

  it('año inválido: lanza sin llamar a DynamoDB', async () => {
    const { repo, commands } = setup();
    await expect(repo.reserveFolioNumber(99)).rejects.toThrow(RangeError);
    expect(commands).toHaveLength(0);
  });
});

describe('putQuote', () => {
  it('Put exacto condicionado a que no exista el quoteId', async () => {
    const { repo, commands } = setup();
    const item = { quoteId: 'Q1', folio: 'CN-2026-00001' };
    await repo.putQuote(item);
    expect(commands).toEqual([
      {
        name: 'PutCommand',
        input: {
          TableName: 'Quotes',
          Item: item,
          ConditionExpression: 'attribute_not_exists(quoteId)',
        },
      },
    ]);
    expect(new PutCommand(commands[0]!.input as never)).toBeInstanceOf(PutCommand);
  });

  it('quoteId repetido (condición fallida): DuplicateQuoteError', async () => {
    const { repo } = setup(() => named('ConditionalCheckFailedException'));
    await expect(repo.putQuote({ quoteId: 'Q1' })).rejects.toBeInstanceOf(DuplicateQuoteError);
  });

  it('otros errores se propagan', async () => {
    const { repo } = setup(() => named('InternalServerError'));
    await expect(repo.putQuote({ quoteId: 'Q1' })).rejects.toMatchObject({
      name: 'InternalServerError',
    });
  });
});

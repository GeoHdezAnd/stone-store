import { BatchGetCommand, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import {
  ConflictError,
  DynamoFreightRepository,
  type FreightTables,
  type PointerRow,
} from '../repository';

const tables: FreightTables = {
  freightConfig: 'T-freight',
  stones: 'T-stones',
  auditLog: 'T-audit',
};

type Input = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Reply = (command: { input: Input }) => unknown;

function setup(reply: Reply) {
  const sent: { name: string; input: Input }[] = [];
  const client = {
    async send(command: { constructor: { name: string }; input: Input }) {
      sent.push({ name: command.constructor.name, input: command.input });
      return reply(command);
    },
  };
  return { sent, repo: new DynamoFreightRepository(client, tables, { sleep: async () => {} }) };
}

const base: PointerRow = {
  version: 'ACTIVE',
  activeVersion: 't0001',
  latestVersion: 't0002',
  activadaPor: 'u',
  activadaAt: 'a',
};
const next: PointerRow = { ...base, activeVersion: 't0003', latestVersion: 't0003' };
const row = { version: 't0003', camiones: [] };
const audit = {
  pk: 'ENTITY#freight-config#t0003',
  sk: 'x#r',
  userId: 'u',
  accion: 'create',
  antes: null,
  despues: null,
};
const AUDIT_COND = 'attribute_not_exists(pk) AND attribute_not_exists(sk)';

describe('lecturas', () => {
  it('getPointer y getVersion: GetItem consistente sobre FreightConfig', async () => {
    const { repo, sent } = setup(() => ({ Item: base }));
    expect(await repo.getPointer()).toEqual(base);
    await repo.getVersion('t0001');
    expect(sent[0]?.name).toBe(GetCommand.name);
    expect(sent[0]?.input).toMatchObject({
      TableName: 'T-freight',
      Key: { version: 'ACTIVE' },
      ConsistentRead: true,
    });
    expect(sent[1]?.input).toMatchObject({ Key: { version: 't0001' }, ConsistentRead: true });
  });

  it('sin fila: null', async () => {
    const { repo } = setup(() => ({}));
    expect(await repo.getPointer()).toBeNull();
    expect(await repo.getVersion('t0001')).toBeNull();
  });

  it('getVersions: BatchGet consistente, reintenta las UnprocessedKeys y ordena desc', async () => {
    let n = 0;
    const { repo, sent } = setup(() => {
      n++;
      return n === 1
        ? {
            Responses: { 'T-freight': [{ version: 't0001' }] },
            UnprocessedKeys: { 'T-freight': { Keys: [{ version: 't0002' }] } },
          }
        : { Responses: { 'T-freight': [{ version: 't0002' }] } };
    });
    const rows = await repo.getVersions(['t0002', 't0001', 't0002']);
    expect(rows.map((r) => r['version'])).toEqual(['t0002', 't0001']);
    expect(sent[0]?.name).toBe(BatchGetCommand.name);
    expect(sent[0]?.input['RequestItems']['T-freight'].Keys).toHaveLength(2);
    expect(sent[0]?.input['RequestItems']['T-freight'].ConsistentRead).toBe(true);
  });

  it('getVersions se rinde si las UnprocessedKeys no se resuelven', async () => {
    const { repo } = setup(() => ({
      UnprocessedKeys: { 'T-freight': { Keys: [{ version: 't0001' }] } },
    }));
    await expect(repo.getVersions(['t0001'])).rejects.toThrow('UnprocessedKeys');
  });

  it('getStones: BatchGet de la tabla Stones por id, sin repetidos', async () => {
    const { repo, sent } = setup(() => ({ Responses: { 'T-stones': [{ id: 'a' }] } }));
    expect(await repo.getStones(['a', 'a'])).toEqual([{ id: 'a' }]);
    expect(sent[0]?.input['RequestItems']['T-stones'].Keys).toEqual([{ id: 'a' }]);
  });

  it('getStones sin ids no llama a AWS', async () => {
    const { repo, sent } = setup(() => ({}));
    expect(await repo.getStones([])).toEqual([]);
    expect(sent).toHaveLength(0);
  });
});

describe('createVersion', () => {
  const ok = () => ({});

  it('es UNA transacción: versión nueva, puntero condicionado a la base y auditoría', async () => {
    const { repo, sent } = setup(ok);
    await repo.createVersion({ basePointer: base, row, pointer: next, audit });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.name).toBe(TransactWriteCommand.name);
    const items = sent[0]?.input['TransactItems'] as Input[];
    expect(items).toHaveLength(3);
    expect(items[0]?.['Put']).toMatchObject({
      TableName: 'T-freight',
      Item: row,
      ConditionExpression: 'attribute_not_exists(#v)',
    });
    expect(items[1]?.['Put']).toMatchObject({
      TableName: 'T-freight',
      Item: next,
      ConditionExpression: '#al = :latest AND #ac = :active',
      ExpressionAttributeValues: { ':latest': 't0002', ':active': 't0001' },
    });
    expect(items[2]?.['Put']).toMatchObject({
      TableName: 'T-audit',
      Item: audit,
      ConditionExpression: AUDIT_COND,
    });
  });

  it('la primera versión exige que el puntero no exista', async () => {
    const { repo, sent } = setup(ok);
    await repo.createVersion({ basePointer: null, row, pointer: next, audit });
    const items = sent[0]?.input['TransactItems'] as Input[];
    expect(items[1]?.['Put']).toMatchObject({ ConditionExpression: 'attribute_not_exists(#v)' });
  });

  const cancelled = (...codes: string[]) =>
    Object.assign(new Error('x'), {
      name: 'TransactionCanceledException',
      CancellationReasons: codes.map((Code) => ({ Code })),
    });

  it.each([
    ['condición de la fila nueva', ['ConditionalCheckFailed', 'None', 'None']],
    ['condición del puntero', ['None', 'ConditionalCheckFailed', 'None']],
    ['transacción en conflicto', ['None', 'None', 'TransactionConflict']],
  ])('%s -> ConflictError', async (_n, codes) => {
    const { repo } = setup(() => {
      throw cancelled(...codes);
    });
    await expect(
      repo.createVersion({ basePointer: base, row, pointer: next, audit }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('un fallo de la auditoría (índice 2) NO es conflicto: se propaga', async () => {
    const { repo } = setup(() => {
      throw cancelled('None', 'None', 'ConditionalCheckFailed');
    });
    const err = await repo
      .createVersion({ basePointer: base, row, pointer: next, audit })
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ConflictError);
    expect((err as Error).name).toBe('TransactionCanceledException');
  });

  it('otros errores se propagan tal cual', async () => {
    const { repo } = setup(() => {
      throw new Error('red caída');
    });
    await expect(
      repo.createVersion({ basePointer: null, row, pointer: next, audit }),
    ).rejects.toThrow('red caída');
  });
});

describe('setActive', () => {
  it('es UNA transacción de 2 ítems: puntero condicionado a la base y auditoría', async () => {
    const { repo, sent } = setup(() => ({}));
    await repo.setActive({ basePointer: base, pointer: next, audit });
    expect(sent).toHaveLength(1);
    const items = sent[0]?.input['TransactItems'] as Input[];
    expect(items).toHaveLength(2);
    expect(items[0]?.['Put']).toMatchObject({
      TableName: 'T-freight',
      Item: next,
      ConditionExpression: '#al = :latest AND #ac = :active',
      ExpressionAttributeValues: { ':latest': 't0002', ':active': 't0001' },
    });
    expect(items[1]?.['Put']).toMatchObject({
      TableName: 'T-audit',
      ConditionExpression: AUDIT_COND,
    });
  });

  it('condición del puntero -> ConflictError; fallo de la auditoría (índice 1) se propaga', async () => {
    const mk = (...codes: string[]) =>
      Object.assign(new Error('x'), {
        name: 'TransactionCanceledException',
        CancellationReasons: codes.map((Code) => ({ Code })),
      });
    const a = setup(() => {
      throw mk('ConditionalCheckFailed', 'None');
    });
    await expect(
      a.repo.setActive({ basePointer: base, pointer: next, audit }),
    ).rejects.toBeInstanceOf(ConflictError);
    const b = setup(() => {
      throw mk('None', 'ConditionalCheckFailed');
    });
    const err = await b.repo
      .setActive({ basePointer: base, pointer: next, audit })
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ConflictError);
  });
});

import { GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { ID_A, quote } from './fixtures';
import { ConflictError, DynamoQuoteRepository, type QuoteTables } from './repository';

const tables: QuoteTables = {
  quotes: 'T-quotes',
  auditLog: 'T-audit',
  byStatusIndex: 'byStatus',
  byDateIndex: 'byDate',
  settings: 'T-settings',
};

type Input = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
function setup(reply: (c: { input: Input }) => unknown) {
  const sent: { name: string; input: Input }[] = [];
  const client = {
    async send(command: { constructor: { name: string }; input: Input }) {
      sent.push({ name: command.constructor.name, input: command.input });
      return reply(command);
    },
  };
  return { sent, repo: new DynamoQuoteRepository(client, tables) };
}
const audit = {
  pk: `ENTITY#quote#${ID_A}`,
  sk: 'x#r',
  userId: 'u',
  accion: 'status',
  antes: null,
  despues: null,
};
const AUDIT_COND = 'attribute_not_exists(pk) AND attribute_not_exists(sk)';

describe('get', () => {
  it('GetItem consistente por quoteId', async () => {
    const { repo, sent } = setup(() => ({ Item: { quoteId: ID_A } }));
    expect(await repo.get(ID_A)).toEqual({ quoteId: ID_A });
    expect(sent[0]?.name).toBe(GetCommand.name);
    expect(sent[0]?.input).toMatchObject({
      TableName: 'T-quotes',
      Key: { quoteId: ID_A },
      ConsistentRead: true,
    });
  });
  it('null si no existe', async () => {
    const { repo } = setup(() => ({}));
    expect(await repo.get(ID_A)).toBeNull();
  });
});

describe('list', () => {
  it('por estado: Query en byStatus, descendente, con rango en sk y filtro q', async () => {
    const { repo, sent } = setup(() => ({
      Items: [{ quoteId: ID_A }],
      LastEvaluatedKey: { quoteId: ID_A, gsi1pk: 'p', gsi1sk: 's' },
    }));
    const out = await repo.list({
      index: 'status',
      status: 'nueva',
      from: 'A',
      to: 'B#~',
      q: 'maria',
      limit: 10,
    });
    expect(out.lastKey).toEqual({ quoteId: ID_A, gsi1pk: 'p', gsi1sk: 's' });
    expect(sent[0]?.name).toBe(QueryCommand.name);
    expect(sent[0]?.input).toMatchObject({
      TableName: 'T-quotes',
      IndexName: 'byStatus',
      KeyConditionExpression: '#pk = :pk AND #sk BETWEEN :from AND :to',
      FilterExpression: 'contains(#sk2, :q)',
      ExpressionAttributeNames: { '#pk': 'gsi1pk', '#sk': 'gsi1sk', '#sk2': 'searchKey' },
      ExpressionAttributeValues: {
        ':pk': 'STATUS#nueva',
        ':from': 'A',
        ':to': 'B#~',
        ':q': 'maria',
      },
      ScanIndexForward: false,
      Limit: 10,
    });
  });

  it('por fecha: partición constante QUOTE, sin filtro ni rango si no se piden', async () => {
    const { repo, sent } = setup(() => ({ Items: [] }));
    const out = await repo.list({ index: 'date', limit: 25 });
    expect(out).toEqual({ items: [], lastKey: null });
    expect(sent[0]?.input).toMatchObject({
      IndexName: 'byDate',
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': 'gsi2pk' },
      ExpressionAttributeValues: { ':pk': 'QUOTE' },
      ScanIndexForward: false,
    });
    expect(sent[0]?.input['FilterExpression']).toBeUndefined();
    // DynamoDB rechaza nombres declarados y sin usar: debe ser igualdad exacta.
    expect(sent[0]?.input['ExpressionAttributeNames']).toEqual({ '#pk': 'gsi2pk' });
  });

  it('solo from o solo to: >= y <=', async () => {
    const a = setup(() => ({ Items: [] }));
    await a.repo.list({ index: 'date', from: 'A', limit: 5 });
    expect(a.sent[0]?.input['KeyConditionExpression']).toBe('#pk = :pk AND #sk >= :from');
    const b = setup(() => ({ Items: [] }));
    await b.repo.list({ index: 'date', to: 'Z', limit: 5 });
    expect(b.sent[0]?.input['KeyConditionExpression']).toBe('#pk = :pk AND #sk <= :to');
  });

  it('pasa el ExclusiveStartKey', async () => {
    const key = { quoteId: ID_A, gsi2pk: 'QUOTE', gsi2sk: 's' };
    const { repo, sent } = setup(() => ({ Items: [] }));
    await repo.list({ index: 'date', limit: 5, exclusiveStartKey: key });
    expect(sent[0]?.input['ExclusiveStartKey']).toEqual(key);
  });
});

describe('update', () => {
  const next = quote({ status: 'en_revision', rev: 2 });
  it('transacción: Put con condición rev + claves de índice recalculadas, y auditoría append-only', async () => {
    const { repo, sent } = setup(() => ({}));
    await repo.update({ next, expectedRev: 1, audit });
    expect(sent[0]?.name).toBe(TransactWriteCommand.name);
    const items = sent[0]!.input['TransactItems'];
    expect(items).toHaveLength(2);
    expect(items[0].Put).toMatchObject({
      TableName: 'T-quotes',
      ConditionExpression: 'attribute_exists(quoteId) AND #rev = :rev',
      ExpressionAttributeNames: { '#rev': 'rev' },
      ExpressionAttributeValues: { ':rev': 1 },
    });
    expect(items[0].Put.Item).toMatchObject({
      quoteId: ID_A,
      rev: 2,
      gsi1pk: 'STATUS#en_revision',
      gsi2pk: 'QUOTE',
      searchKey: 'cn-2026-00001 maria perez 5550101 72810',
    });
    expect(items[1].Put).toMatchObject({
      TableName: 'T-audit',
      Item: audit,
      ConditionExpression: AUDIT_COND,
    });
  });

  it('ConditionalCheckFailed de la solicitud (índice 0) -> ConflictError', async () => {
    const err = Object.assign(new Error('x'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
    });
    const { repo } = setup(() => {
      throw err;
    });
    await expect(repo.update({ next, expectedRev: 1, audit })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('TransactionConflict -> ConflictError; fallo de la auditoría NO es conflicto', async () => {
    const mk = (reasons: unknown[]) =>
      Object.assign(new Error('x'), {
        name: 'TransactionCanceledException',
        CancellationReasons: reasons,
      });
    const a = setup(() => {
      throw mk([{ Code: 'TransactionConflict' }, { Code: 'None' }]);
    });
    await expect(a.repo.update({ next, expectedRev: 1, audit })).rejects.toBeInstanceOf(
      ConflictError,
    );
    const b = setup(() => {
      throw mk([{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }]);
    });
    await expect(b.repo.update({ next, expectedRev: 1, audit })).rejects.not.toBeInstanceOf(
      ConflictError,
    );
  });
});

describe('getSettings', () => {
  it('GetItem consistente por clave PUBLIC o MAIL en Settings', async () => {
    const { repo, sent } = setup(() => ({ Item: { key: 'MAIL', asuntoCotizacion: 'x' } }));
    expect(await repo.getSettings('MAIL')).toEqual({ key: 'MAIL', asuntoCotizacion: 'x' });
    expect(sent[0]?.name).toBe(GetCommand.name);
    expect(sent[0]?.input).toMatchObject({
      TableName: 'T-settings',
      Key: { key: 'MAIL' },
      ConsistentRead: true,
    });
  });
  it('null si no existe', async () => {
    const { repo } = setup(() => ({}));
    expect(await repo.getSettings('PUBLIC')).toBeNull();
  });
});

describe('update sin auditoría (reclamo y liberación del candado de envío)', () => {
  it('transacción con un solo Put condicionado a rev', async () => {
    const { repo, sent } = setup(() => ({}));
    await repo.update({ next: quote({ rev: 2 }), expectedRev: 1 });
    const items = sent[0]!.input['TransactItems'];
    expect(items).toHaveLength(1);
    expect(items[0].Put).toMatchObject({
      TableName: 'T-quotes',
      ConditionExpression: 'attribute_exists(quoteId) AND #rev = :rev',
      ExpressionAttributeValues: { ':rev': 1 },
    });
  });
});

import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { queryQuotesIndex } from '../quotes-query';

const tables = { quotes: 'T-quotes', byStatusIndex: 'byStatus', byDateIndex: 'byDate' };
type Input = Record<string, unknown>;

function setup(reply: unknown = {}) {
  const sent: { name: string; input: Input }[] = [];
  const client = {
    async send(command: { constructor: { name: string }; input: Input }) {
      sent.push({ name: command.constructor.name, input: command.input });
      return reply;
    },
  };
  return { sent, client };
}

describe('queryQuotesIndex', () => {
  it('por estado con rango: Query en byStatus, descendente, nombres usados exactamente', async () => {
    const { sent, client } = setup({
      Items: [{ quoteId: 'A' }],
      LastEvaluatedKey: { quoteId: 'A' },
    });
    const out = await queryQuotesIndex(client, tables, {
      index: 'status',
      status: 'nueva',
      from: 'A',
      to: 'B#~',
      limit: 10,
    });
    expect(out).toEqual({ items: [{ quoteId: 'A' }], lastKey: { quoteId: 'A' } });
    expect(sent[0]?.name).toBe(QueryCommand.name);
    expect(sent[0]?.input).toEqual({
      TableName: 'T-quotes',
      IndexName: 'byStatus',
      KeyConditionExpression: '#pk = :pk AND #sk BETWEEN :from AND :to',
      ExpressionAttributeNames: { '#pk': 'gsi1pk', '#sk': 'gsi1sk' },
      ExpressionAttributeValues: { ':pk': 'STATUS#nueva', ':from': 'A', ':to': 'B#~' },
      ScanIndexForward: false,
      Limit: 10,
    });
  });
  it('por fecha sin rango: no declara #sk (DynamoDB rechaza nombres sin usar) y pagina', async () => {
    const { sent, client } = setup();
    const out = await queryQuotesIndex(client, tables, {
      index: 'date',
      limit: 200,
      exclusiveStartKey: { quoteId: 'Z' },
    });
    expect(out).toEqual({ items: [], lastKey: null });
    expect(sent[0]?.input).toEqual({
      TableName: 'T-quotes',
      IndexName: 'byDate',
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': 'gsi2pk' },
      ExpressionAttributeValues: { ':pk': 'QUOTE' },
      ScanIndexForward: false,
      Limit: 200,
      ExclusiveStartKey: { quoteId: 'Z' },
    });
  });
  it('solo `from`: >=; solo `to`: <=; con `q` agrega el filtro contains', async () => {
    const a = setup();
    await queryQuotesIndex(a.client, tables, { index: 'date', from: 'F', limit: 5 });
    expect(a.sent[0]?.input['KeyConditionExpression']).toBe('#pk = :pk AND #sk >= :from');
    const b = setup();
    await queryQuotesIndex(b.client, tables, { index: 'date', to: 'T', q: 'maria', limit: 5 });
    expect(b.sent[0]?.input['KeyConditionExpression']).toBe('#pk = :pk AND #sk <= :to');
    expect(b.sent[0]?.input['FilterExpression']).toBe('contains(#sk2, :q)');
    expect(b.sent[0]?.input['ExpressionAttributeNames']).toEqual({
      '#pk': 'gsi2pk',
      '#sk': 'gsi2sk',
      '#sk2': 'searchKey',
    });
  });
  it('sin índice por fecha configurado, consultar por fecha falla antes de tocar la base', async () => {
    const { sent, client } = setup();
    await expect(
      queryQuotesIndex(
        client,
        { quotes: 'T', byStatusIndex: 'byStatus' },
        { index: 'date', limit: 5 },
      ),
    ).rejects.toThrow();
    expect(sent).toEqual([]);
    // Por estado funciona sin el índice por fecha.
    await queryQuotesIndex(
      client,
      { quotes: 'T', byStatusIndex: 'byStatus' },
      { index: 'status', status: 'nueva', limit: 5 },
    );
    expect(sent).toHaveLength(1);
  });
});

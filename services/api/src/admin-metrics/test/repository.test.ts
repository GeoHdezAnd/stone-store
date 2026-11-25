import { BatchGetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { DynamoMetricsRepository, type MetricsTables } from '../repository';

const tables: MetricsTables = {
  quotes: 'T-quotes',
  byStatusIndex: 'byStatus',
  postalCodes: 'T-cp',
};

type Input = Record<string, unknown>;
function setup(reply: unknown) {
  const sent: { name: string; input: Input }[] = [];
  const client = {
    async send(command: { constructor: { name: string }; input: Input }) {
      sent.push({ name: command.constructor.name, input: command.input });
      return reply;
    },
  };
  return { sent, repo: new DynamoMetricsRepository(client, tables) };
}

describe('queryQuotes', () => {
  it('hace Query sobre el índice (nunca Scan ni la tabla base)', async () => {
    const { repo, sent } = setup({ Items: [{ quoteId: 'A' }] });
    const out = await repo.queryQuotes({ index: 'status', status: 'nueva', limit: 200 });
    expect(out).toEqual({ items: [{ quoteId: 'A' }], lastKey: null });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.name).toBe(QueryCommand.name);
    expect(sent[0]?.input['IndexName']).toBe('byStatus');
  });
});

describe('getPostalStates', () => {
  it('BatchGetItem con proyección mínima (cp y estado) y devuelve cp -> estado', async () => {
    const { repo, sent } = setup({
      Responses: {
        'T-cp': [
          { cp: '72810', estado: 'Puebla' },
          { cp: '90000', estado: 'Tlaxcala' },
        ],
      },
    });
    const out = await repo.getPostalStates(['72810', '90000', '11111']);
    expect(out).toEqual({
      states: { '72810': 'Puebla', '90000': 'Tlaxcala' },
      unprocessed: [],
    });
    expect(sent[0]?.name).toBe(BatchGetCommand.name);
    expect(sent[0]?.input).toEqual({
      RequestItems: {
        'T-cp': {
          Keys: [{ cp: '72810' }, { cp: '90000' }, { cp: '11111' }],
          ProjectionExpression: '#cp, #estado',
          ExpressionAttributeNames: { '#cp': 'cp', '#estado': 'estado' },
        },
      },
    });
  });
  it('devuelve las claves sin procesar', async () => {
    const { repo } = setup({
      Responses: { 'T-cp': [] },
      UnprocessedKeys: { 'T-cp': { Keys: [{ cp: '72810' }] } },
    });
    expect((await repo.getPostalStates(['72810'])).unprocessed).toEqual(['72810']);
  });
  it('tolera respuestas vacías y filas con forma inesperada', async () => {
    const { repo } = setup({ Responses: { 'T-cp': [{ cp: 5 }, { cp: '72810' }, null] } });
    expect(await repo.getPostalStates(['72810'])).toEqual({ states: {}, unprocessed: [] });
    const empty = setup({});
    expect(await empty.repo.getPostalStates(['72810'])).toEqual({ states: {}, unprocessed: [] });
  });
  it('rechaza lotes de más de 100 claves (límite de BatchGetItem)', async () => {
    const { repo, sent } = setup({});
    const many = Array.from({ length: 101 }, (_, i) => String(i).padStart(5, '0'));
    await expect(repo.getPostalStates(many)).rejects.toThrow();
    expect(sent).toEqual([]);
  });
});

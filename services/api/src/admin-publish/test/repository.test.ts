import {
  BatchGetCommand,
  GetCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { ConflictError, DynamoPublishRepository, type PublishTables } from '../repository';

const tables: PublishTables = {
  stones: 'T-stones',
  projects: 'T-projects',
  finishes: 'T-finishes',
  services: 'T-services',
  settings: 'T-settings',
  publications: 'T-pub',
  auditLog: 'T-audit',
  auditScopeIndex: 'scope-sk-index',
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
  return { sent, repo: new DynamoPublishRepository(client, tables, { sleep: async () => {} }) };
}

const publication = {
  version: 'v0002',
  action: 'publish' as const,
  hash: 'h',
  generatedAt: 'g',
  publishedAt: 'p',
  publishedBy: 'u',
  s3Key: 'published/v0002/catalog.json',
  counts: { stones: 1, finishes: 0, projects: 0, services: 0 },
};
const audit = {
  pk: 'ENTITY#publication#v0002',
  sk: 'x#r',
  userId: 'u',
  accion: 'publish',
  antes: null,
  despues: null,
};

describe('readCatalog', () => {
  it('lee las 4 tablas con Scan consistente y SOLO la fila PUBLIC de Settings', async () => {
    const { repo, sent } = setup((c) =>
      c.input['Key'] ? { Item: { key: 'PUBLIC' } } : { Items: [] },
    );
    const r = await repo.readCatalog();
    expect(r.publicSettings).toEqual({ key: 'PUBLIC' });
    const scans = sent.filter((s) => s.name === ScanCommand.name).map((s) => s.input['TableName']);
    expect(scans.sort()).toEqual(['T-finishes', 'T-projects', 'T-services', 'T-stones']);
    const gets = sent.filter((s) => s.name === GetCommand.name);
    expect(gets).toHaveLength(1);
    expect(gets[0]?.input).toMatchObject({
      TableName: 'T-settings',
      Key: { key: 'PUBLIC' },
      ConsistentRead: true,
    });
    expect(JSON.stringify(sent)).not.toContain('MAIL');
  });

  it('pagina el Scan con LastEvaluatedKey', async () => {
    let n = 0;
    const { repo } = setup((c) => {
      if (c.input['Key']) return {};
      if (c.input['TableName'] !== 'T-stones') return { Items: [] };
      n++;
      return n === 1
        ? { Items: [{ id: 'a' }], LastEvaluatedKey: { id: 'a' } }
        : { Items: [{ id: 'b' }] };
    });
    expect((await repo.readCatalog()).stones.map((s) => s['id'])).toEqual(['a', 'b']);
  });

  it('falla si el Scan nunca termina (tope de páginas)', async () => {
    const { repo } = setup((c) =>
      c.input['Key'] ? {} : { Items: [], LastEvaluatedKey: { id: 'x' } },
    );
    await expect(repo.readCatalog()).rejects.toThrow(/tope/);
  });
});

describe('lecturas de Publications', () => {
  it('getCurrent y getPublication usan GetItem consistente con la clave exacta', async () => {
    const { repo, sent } = setup(() => ({}));
    await repo.getCurrent();
    await repo.getPublication('v0001');
    expect(sent.map((s) => s.input['Key'])).toEqual([{ version: 'CURRENT' }, { version: 'v0001' }]);
    expect(sent.every((s) => s.input['ConsistentRead'] === true)).toBe(true);
  });

  it('getPublications usa BatchGet, reintenta UnprocessedKeys y ordena de la más nueva a la más vieja', async () => {
    let n = 0;
    const { repo, sent } = setup(() => {
      n++;
      return n === 1
        ? {
            Responses: { 'T-pub': [{ version: 'v0001' }] },
            UnprocessedKeys: { 'T-pub': { Keys: [{ version: 'v0002' }] } },
          }
        : { Responses: { 'T-pub': [{ version: 'v0002' }] } };
    });
    const rows = await repo.getPublications(['v0002', 'v0001']);
    expect(rows.map((r) => r.version)).toEqual(['v0002', 'v0001']);
    expect(sent.every((s) => s.name === BatchGetCommand.name)).toBe(true);
  });

  it('getPublications falla si las UnprocessedKeys nunca se resuelven', async () => {
    const { repo } = setup(() => ({ UnprocessedKeys: { 'T-pub': { Keys: [{ version: 'v1' }] } } }));
    await expect(repo.getPublications(['v0001'])).rejects.toThrow(/UnprocessedKeys/);
  });
});

describe('listPending', () => {
  it('consulta el GSI disperso por scope=CATALOG y sk > corte, recientes primero', async () => {
    const { repo, sent } = setup(() => ({
      Items: [
        {
          pk: 'ENTITY#stone#arenisca',
          sk: '2026-11-19T11:00:00.000Z#r',
          accion: 'update',
          userId: 'u',
        },
      ],
    }));
    const page = await repo.listPending('2026-11-19T10:00:00.000Z', 100);
    expect(page).toEqual({
      items: [
        {
          entity: 'stone',
          id: 'arenisca',
          at: '2026-11-19T11:00:00.000Z',
          accion: 'update',
          userId: 'u',
        },
      ],
      truncated: false,
    });
    expect(sent[0]?.name).toBe(QueryCommand.name);
    expect(sent[0]?.input).toMatchObject({
      TableName: 'T-audit',
      IndexName: 'scope-sk-index',
      KeyConditionExpression: '#scope = :scope AND #sk > :since',
      ExpressionAttributeValues: { ':scope': 'CATALOG', ':since': '2026-11-19T10:00:00.000Z' },
      ScanIndexForward: false,
      Limit: 101,
    });
  });

  it('sin corte no filtra por sk; marca truncated si hay más que el tope', async () => {
    const row = (i: number) => ({
      pk: `ENTITY#stone#s${i}`,
      sk: `2026-11-19T11:00:0${i}.000Z#r`,
      accion: 'create',
      userId: 'u',
    });
    const { repo, sent } = setup(() => ({ Items: [row(1), row(2), row(3)] }));
    const page = await repo.listPending(null, 2);
    expect(page.items).toHaveLength(2);
    expect(page.truncated).toBe(true);
    expect(sent[0]?.input['KeyConditionExpression']).toBe('#scope = :scope');
  });

  it('ignora filas mal formadas', async () => {
    const { repo } = setup(() => ({ Items: [{ pk: 'otra-cosa', sk: 'x' }] }));
    expect((await repo.listPending(null, 10)).items).toEqual([]);
  });
});

describe('commit', () => {
  const ok = () => ({});

  it('es UNA transacción: fila nueva, CURRENT condicionado a la base y auditoría', async () => {
    const { repo, sent } = setup(ok);
    await repo.commit({ baseVersion: 'v0001', publication, audit });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.name).toBe(TransactWriteCommand.name);
    const items = sent[0]?.input['TransactItems'] as Input[];
    expect(items).toHaveLength(3);
    expect(items[0]?.['Put']).toMatchObject({
      TableName: 'T-pub',
      Item: publication,
      ConditionExpression: 'attribute_not_exists(#v)',
    });
    expect(items[1]?.['Put']).toMatchObject({
      TableName: 'T-pub',
      Item: { version: 'CURRENT', currentVersion: 'v0002', hash: 'h', generatedAt: 'g' },
      ConditionExpression: '#cv = :base',
      ExpressionAttributeValues: { ':base': 'v0001' },
    });
    expect(items[2]?.['Put']).toMatchObject({
      TableName: 'T-audit',
      Item: audit,
      ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
    });
  });

  it('en la primera publicación CURRENT exige que no exista', async () => {
    const { repo, sent } = setup(ok);
    await repo.commit({ baseVersion: null, publication, audit });
    const items = sent[0]?.input['TransactItems'] as Input[];
    expect(items[1]?.['Put']).toMatchObject({ ConditionExpression: 'attribute_not_exists(#v)' });
  });

  const cancelled = (...codes: string[]) =>
    Object.assign(new Error('x'), {
      name: 'TransactionCanceledException',
      CancellationReasons: codes.map((Code) => ({ Code })),
    });

  it.each([
    ['condición de la fila v<N>', ['ConditionalCheckFailed', 'None', 'None']],
    ['condición de CURRENT', ['None', 'ConditionalCheckFailed', 'None']],
    ['transacción en conflicto', ['None', 'TransactionConflict', 'None']],
  ])('%s -> ConflictError', async (_n, codes) => {
    const { repo } = setup(() => {
      throw cancelled(...codes);
    });
    await expect(repo.commit({ baseVersion: 'v0001', publication, audit })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('un fallo de la auditoría (índice 2) NO es conflicto: se propaga', async () => {
    const { repo } = setup(() => {
      throw cancelled('None', 'None', 'ConditionalCheckFailed');
    });
    const err = await repo
      .commit({ baseVersion: 'v0001', publication, audit })
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ConflictError);
    expect((err as Error).name).toBe('TransactionCanceledException');
  });

  it('otros errores se propagan tal cual', async () => {
    const { repo } = setup(() => {
      throw new Error('red caída');
    });
    await expect(repo.commit({ baseVersion: null, publication, audit })).rejects.toThrow(
      'red caída',
    );
  });
});

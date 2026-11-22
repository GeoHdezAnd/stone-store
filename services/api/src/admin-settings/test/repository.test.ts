import { describe, expect, it } from 'vitest';
import type { AuditEntry } from '../../lib/audit';
import { publicSettings } from './fixtures';
import { ConflictError, DynamoSettingsRepository } from '../repository';

const audit: AuditEntry = {
  pk: 'ENTITY#settings#public',
  sk: '2026-11-18T10:00:00.000Z#req-1',
  userId: 'user-1',
  accion: 'update',
  antes: null,
  despues: { nombrePatio: 'x' },
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
  new DynamoSettingsRepository(client, 't-settings', 't-audit');

describe('DynamoSettingsRepository.get', () => {
  it('lee con GetItem CONSISTENTE por la clave PUBLIC o MAIL', async () => {
    const f = fakeClient(() => ({ Item: { key: 'PUBLIC', nombrePatio: 'x' } }));
    const row = await repoWith(f.client).get('PUBLIC');
    expect(row).toEqual({ key: 'PUBLIC', nombrePatio: 'x' });
    await repoWith(f.client).get('MAIL');
    expect(f.commands.map((c) => c.name)).toEqual(['GetCommand', 'GetCommand']);
    expect(f.commands[0]?.input).toEqual({
      TableName: 't-settings',
      Key: { key: 'PUBLIC' },
      ConsistentRead: true,
    });
    expect(f.commands[1]?.input['Key']).toEqual({ key: 'MAIL' });
    expect(f.commands[1]?.input['ConsistentRead']).toBe(true);
  });

  it('sin fila devuelve null', async () => {
    const f = fakeClient(() => ({}));
    expect(await repoWith(f.client).get('MAIL')).toBeNull();
  });
});

describe('DynamoSettingsRepository.put', () => {
  it('transacción con EXACTAMENTE 2 Put: la fila SIN condición y la auditoría con su condición', async () => {
    const f = fakeClient();
    const data = publicSettings();
    await repoWith(f.client).put('PUBLIC', data, audit);
    expect(f.commands).toHaveLength(1);
    expect(f.commands[0]?.name).toBe('TransactWriteCommand');
    const items = f.commands[0]?.input['TransactItems'];
    expect(items).toHaveLength(2);
    // UPSERT: sin ConditionExpression (no depende de que el seed haya corrido).
    expect(items[0]).toEqual({
      Put: { TableName: 't-settings', Item: { ...data, key: 'PUBLIC' } },
    });
    expect(items[1]).toEqual({
      Put: {
        TableName: 't-audit',
        Item: audit,
        ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
      },
    });
  });

  it('la clave `key` de la fila la decide el repositorio, no los datos', async () => {
    const f = fakeClient();
    await repoWith(f.client).put('MAIL', { key: 'PUBLIC', a: 1 }, audit);
    expect(f.commands[0]?.input['TransactItems'][0].Put.Item.key).toBe('MAIL');
  });

  it('jamás emite Delete, Update ni ConditionCheck', async () => {
    const f = fakeClient();
    await repoWith(f.client).put('PUBLIC', publicSettings(), audit);
    for (const c of f.commands) {
      expect(c.name).not.toMatch(/Delete|Update/);
      for (const i of c.input['TransactItems'] ?? []) {
        expect(Object.keys(i)).toEqual(['Put']);
      }
    }
  });

  it('TransactionConflict en cualquier índice -> ConflictError', async () => {
    for (const codes of [
      ['TransactionConflict', 'None'],
      ['None', 'TransactionConflict'],
    ]) {
      const f = fakeClient(() => cancelled(...codes));
      await expect(
        repoWith(f.client).put('PUBLIC', publicSettings(), audit),
      ).rejects.toBeInstanceOf(ConflictError);
    }
  });

  it('ConditionalCheckFailed en la auditoría NO es de dominio: se propaga el error original', async () => {
    const original = cancelled('None', 'ConditionalCheckFailed');
    const f = fakeClient(() => original);
    await expect(repoWith(f.client).put('PUBLIC', publicSettings(), audit)).rejects.toBe(original);
  });

  it('ConditionalCheckFailed en la fila tampoco se mapea (no hay condición ahí)', async () => {
    const original = cancelled('ConditionalCheckFailed', 'None');
    const f = fakeClient(() => original);
    const p = repoWith(f.client).put('PUBLIC', publicSettings(), audit);
    await expect(p).rejects.toBe(original);
    await expect(p).rejects.not.toBeInstanceOf(ConflictError);
  });

  it('otros errores se propagan tal cual', async () => {
    const boom = new Error('boom');
    const f = fakeClient(() => boom);
    await expect(repoWith(f.client).put('MAIL', { a: 1 }, audit)).rejects.toBe(boom);
  });
});

import { describe, expect, it } from 'vitest';
import type { AuditEntry } from '../lib/audit';
import { finish, stone } from './fixtures';
import { MemoryCatalogRepository } from './memory-repository';
import { AlreadyExistsError, NotFoundError } from './repository';

const audit: AuditEntry = {
  pk: 'ENTITY#stone#x',
  sk: '2026-11-18T10:00:00.000Z#r1',
  userId: 'u1',
  accion: 'create',
  antes: null,
  despues: null,
};

describe('MemoryCatalogRepository (doble de pruebas)', () => {
  it('pagina en varias páginas y la última no trae cursor', async () => {
    const repo = new MemoryCatalogRepository();
    for (const id of ['a', 'b', 'c', 'd', 'e']) await repo.create('stone', stone({ id }), audit);
    const p1 = await repo.list('stone', { limit: 2 });
    expect(p1.items.map((i) => i['id'])).toEqual(['a', 'b']);
    expect(p1.lastKey).toEqual({ id: 'b' });
    const p2 = await repo.list('stone', { limit: 2, exclusiveStartKey: { id: 'b' } });
    expect(p2.items.map((i) => i['id'])).toEqual(['c', 'd']);
    const p3 = await repo.list('stone', { limit: 2, exclusiveStartKey: { id: 'd' } });
    expect(p3.items.map((i) => i['id'])).toEqual(['e']);
    expect(p3.lastKey).toBeNull();
  });

  it('una página exacta no deja cursor colgando', async () => {
    const repo = new MemoryCatalogRepository();
    for (const id of ['a', 'b']) await repo.create('stone', stone({ id }), audit);
    expect((await repo.list('stone', { limit: 2 })).lastKey).toBeNull();
  });

  it('create duplicado lanza AlreadyExists; replace y softDelete inexistente, NotFound', async () => {
    const repo = new MemoryCatalogRepository();
    await repo.create('finish', finish(), audit);
    await expect(repo.create('finish', finish(), audit)).rejects.toBeInstanceOf(AlreadyExistsError);
    await expect(repo.replace('finish', finish({ id: 'otro' }), audit)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(repo.softDelete('finish', 'otro', audit)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('existsAll devuelve los ids que faltan', async () => {
    const repo = new MemoryCatalogRepository();
    await repo.create('finish', finish(), audit);
    expect(await repo.existsAll('finish', ['apomazado', 'x', 'x'])).toEqual(['x']);
  });
});

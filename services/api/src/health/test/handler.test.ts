import { expect, it } from 'vitest';
import { handler } from '../handler';

it('responde ok sin exigir claims', async () => {
  const res = await handler();
  expect(res.statusCode).toBe(200);
  expect(JSON.parse(res.body as string)).toEqual({ status: 'ok' });
});

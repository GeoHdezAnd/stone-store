import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { handler } from '../handler';

type Ev = APIGatewayProxyEventV2WithJWTAuthorizer;

const ev = (claims?: Record<string, string>): Ev =>
  ({
    rawPath: '/admin/me',
    isBase64Encoded: false,
    requestContext: {
      requestId: 'r1',
      http: { method: 'GET' },
      ...(claims ? { authorizer: { jwt: { claims, scopes: [] } } } : {}),
    },
  }) as unknown as Ev;

describe('GET /admin/me', () => {
  it('devuelve userId y roles para owner y staff', async () => {
    const res = await handler(
      ev({ sub: 'u1', token_use: 'access', 'cognito:groups': '[owner staff]' }),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body as string)).toEqual({ userId: 'u1', roles: ['owner', 'staff'] });
  });

  it('un grupo desconocido da 403', async () => {
    const res = await handler(
      ev({ sub: 'u1', token_use: 'access', 'cognito:groups': '[owner-solo-lectura]' }),
    );
    expect(res.statusCode).toBe(403);
  });

  it('un id token (token_use=id) da 401 aunque traiga el grupo correcto', async () => {
    const res = await handler(ev({ sub: 'u1', token_use: 'id', 'cognito:groups': '[owner]' }));
    expect(res.statusCode).toBe(401);
  });

  it('sin claims da 401', async () => {
    expect((await handler(ev())).statusCode).toBe(401);
  });
});

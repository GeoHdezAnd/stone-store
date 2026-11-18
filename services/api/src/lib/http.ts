import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

/**
 * Error de negocio con status HTTP y un código estable (`not_found`, `conflict`...).
 * Solo el código llega al cliente; el mensaje es para los logs.
 */
export class HttpError extends Error {
  readonly status: number;

  constructor(
    status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'HttpError';
    // Un status fuera de 400-599 es un bug del handler: se trata como 500.
    this.status = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
  }
}

/** Respuesta payload v2. Las cabeceras de seguridad no se pueden sobrescribir. */
export function jsonResponse(
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): APIGatewayProxyStructuredResultV2 {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(extraHeaders)) headers[k.toLowerCase()] = v;
  return {
    statusCode: status,
    headers: {
      ...headers,
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'strict-transport-security': 'max-age=31536000; includeSubDomains',
    },
    body: JSON.stringify(body),
  };
}

import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { jsonResponse } from '../lib/http';

/**
 * `GET /health` es la ÚNICA ruta pública de la API: no pasa por el authorizer ni por el
 * router de administración, y no expone datos. Cualquier otra ruta debe pasar por el router.
 */
export async function handler(): Promise<APIGatewayProxyStructuredResultV2> {
  return jsonResponse(200, { status: 'ok' });
}

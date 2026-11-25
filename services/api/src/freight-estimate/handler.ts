import { GeoRoutesClient } from '@aws-sdk/client-geo-routes';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createRouteProvider, GEO_ROUTES_CLIENT_CONFIG } from '../lib/route-provider';
import { loadConfig } from './config';
import { createFreightEstimateHandler } from './estimate';
import { DynamoFreightEstimateRepository } from './repository';

// `POST /freight/estimate` es una ruta PÚBLICA: no pasa por el authorizer ni por `createRouter`.
// El entorno se lee y los clientes se crean UNA vez, al arrancar (se reutilizan entre invocaciones).
const config = loadConfig(process.env);
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const repo = new DynamoFreightEstimateRepository(doc, config);
// `ROUTE_PROVIDER` obligatorio: `location` (AWS real) o `haversine` (emulador). Sin él, falla al arrancar.
const routes = createRouteProvider(process.env, {
  geoRoutes: () => new GeoRoutesClient({ ...GEO_ROUTES_CLIENT_CONFIG }),
});

export const handler = createFreightEstimateHandler({ repo, routes }).handle;

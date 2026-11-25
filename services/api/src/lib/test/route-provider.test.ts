import { CalculateRoutesCommand, GeoRoutesClient } from '@aws-sdk/client-geo-routes';
import { describe, expect, it } from 'vitest';
import {
  createRouteProvider,
  GEO_ROUTES_CLIENT_CONFIG,
  HAVERSINE_ROAD_FACTOR,
  HaversineRouteProvider,
  LocationRouteProvider,
  RouteProviderError,
} from '../route-provider';

const PUEBLA = { lat: 19.043, lng: -98.198 };
const CDMX = { lat: 19.43, lng: -99.13 };

describe('HaversineRouteProvider (solo emulador)', () => {
  const provider = new HaversineRouteProvider();

  it('el factor de carretera es una constante nombrada de 1.3', () => {
    expect(HAVERSINE_ROAD_FACTOR).toBe(1.3);
  });

  it('mismo punto: 0 km', async () => {
    expect(await provider.getDistanceKm(PUEBLA, PUEBLA)).toBe(0);
  });

  it('Puebla a CDMX: línea recta (~106.9 km) × 1.3, a 0.1 km', async () => {
    expect(await provider.getDistanceKm(PUEBLA, CDMX)).toBe(139);
  });

  it('un grado de longitud en el ecuador (~111.2 km) × 1.3', async () => {
    expect(await provider.getDistanceKm({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })).toBe(144.6);
  });

  it('es simétrica', async () => {
    expect(await provider.getDistanceKm(CDMX, PUEBLA)).toBe(
      await provider.getDistanceKm(PUEBLA, CDMX),
    );
  });

  it('coordenadas no finitas o fuera de rango: RouteProviderError', async () => {
    await expect(provider.getDistanceKm({ lat: Number.NaN, lng: 0 }, CDMX)).rejects.toThrow(
      RouteProviderError,
    );
    await expect(provider.getDistanceKm(PUEBLA, { lat: 91, lng: 0 })).rejects.toThrow(
      RouteProviderError,
    );
    await expect(provider.getDistanceKm(PUEBLA, { lat: 0, lng: 181 })).rejects.toThrow(
      RouteProviderError,
    );
  });
});

function fakeClient(reply: unknown) {
  const sent: unknown[] = [];
  return {
    sent,
    client: {
      async send(command: unknown) {
        sent.push(command);
        if (reply instanceof Error) throw reply;
        return reply;
      },
    },
  };
}

const vehicleLeg = (details: Record<string, unknown>) => ({ VehicleLegDetails: details });
const summary = (meters: number) => ({ Overview: { Distance: meters, Duration: 100 } });

describe('LocationRouteProvider', () => {
  it('pide CalculateRoutes en modo Truck con [lng, lat], con Summary y sin peajes', async () => {
    const { client, sent } = fakeClient({
      Routes: [{ Legs: [vehicleLeg({ Summary: summary(62_345) })] }],
    });
    const km = await new LocationRouteProvider(client).getDistanceKm(PUEBLA, CDMX);
    expect(km).toBe(62.3);
    expect(sent).toHaveLength(1);
    const command = sent[0] as CalculateRoutesCommand;
    expect(command).toBeInstanceOf(CalculateRoutesCommand);
    expect(command.input).toEqual({
      Origin: [PUEBLA.lng, PUEBLA.lat],
      Destination: [CDMX.lng, CDMX.lat],
      TravelMode: 'Truck',
      LegAdditionalFeatures: ['Summary'],
    });
    expect(command.input).not.toHaveProperty('Tolls');
  });

  it('suma la distancia de todas las piernas (Summary.Overview.Distance, en metros)', async () => {
    const { client } = fakeClient({
      Routes: [
        {
          Legs: [vehicleLeg({ Summary: summary(10_000) }), vehicleLeg({ Summary: summary(5_050) })],
        },
      ],
    });
    expect(await new LocationRouteProvider(client).getDistanceKm(PUEBLA, CDMX)).toBe(15.1);
  });

  it('sin Summary, suma TravelSteps[].Distance', async () => {
    const { client } = fakeClient({
      Routes: [
        {
          Legs: [
            vehicleLeg({
              TravelSteps: [{ Distance: 1_000 }, { Distance: 2_500 }, { Distance: 500 }],
            }),
          ],
        },
      ],
    });
    expect(await new LocationRouteProvider(client).getDistanceKm(PUEBLA, CDMX)).toBe(4);
  });

  it('prefiere Summary sobre TravelSteps cuando vienen los dos', async () => {
    const { client } = fakeClient({
      Routes: [
        {
          Legs: [vehicleLeg({ Summary: summary(8_000), TravelSteps: [{ Distance: 999_000 }] })],
        },
      ],
    });
    expect(await new LocationRouteProvider(client).getDistanceKm(PUEBLA, CDMX)).toBe(8);
  });

  it('respuestas SIN ruta o sin piernas: RouteProviderError con motivo `no_route`', async () => {
    const sinRuta: unknown[] = [undefined, {}, { Routes: [] }, { Routes: [{ Legs: [] }] }];
    for (const reply of sinRuta) {
      const { client } = fakeClient(reply);
      const err = await new LocationRouteProvider(client)
        .getDistanceKm(PUEBLA, CDMX)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RouteProviderError);
      expect((err as RouteProviderError).reason).toBe('no_route');
    }
  });

  it('respuestas con piernas pero sin distancia válida: RouteProviderError `bad_response` (no `no_route`)', async () => {
    const malas: unknown[] = [
      { Routes: [{ Legs: [{}] }] },
      { Routes: [{ Legs: [vehicleLeg({})] }] },
      { Routes: [{ Legs: [vehicleLeg({ Summary: summary(-5) })] }] },
      { Routes: [{ Legs: [vehicleLeg({ Summary: summary(Number.NaN) })] }] },
      { Routes: [{ Legs: [vehicleLeg({ Summary: { Overview: { Distance: '10' } } })] }] },
      { Routes: [{ Legs: [vehicleLeg({ TravelSteps: [{ Distance: Infinity }] })] }] },
    ];
    for (const reply of malas) {
      const { client } = fakeClient(reply);
      const err = await new LocationRouteProvider(client)
        .getDistanceKm(PUEBLA, CDMX)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RouteProviderError);
      expect((err as RouteProviderError).reason).toBe('bad_response');
    }
  });

  it('cualquier fallo del SDK se vuelve RouteProviderError sin filtrar el mensaje original', async () => {
    const original = Object.assign(new Error('arn:aws:geo-routes:us-east-1::provider/default no'), {
      name: 'AccessDeniedException',
    });
    const { client } = fakeClient(original);
    const err = await new LocationRouteProvider(client)
      .getDistanceKm(PUEBLA, CDMX)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RouteProviderError);
    expect((err as Error).message).not.toContain('arn:');
    expect((err as RouteProviderError).cause).toBeUndefined();
  });

  it('valida las coordenadas antes de llamar a AWS', async () => {
    const { client, sent } = fakeClient({});
    await expect(
      new LocationRouteProvider(client).getDistanceKm({ lat: 200, lng: 0 }, CDMX),
    ).rejects.toThrow(RouteProviderError);
    expect(sent).toHaveLength(0);
  });
});

describe('createRouteProvider', () => {
  const deps = {
    geoRoutes: () => {
      throw new Error('no debe crearse el cliente');
    },
  };

  it('haversine no crea el cliente de AWS', () => {
    expect(createRouteProvider({ ROUTE_PROVIDER: 'haversine' }, deps)).toBeInstanceOf(
      HaversineRouteProvider,
    );
  });

  it('location crea el proveedor con el cliente inyectado', () => {
    const { client } = fakeClient({});
    expect(
      createRouteProvider({ ROUTE_PROVIDER: 'location' }, { geoRoutes: () => client }),
    ).toBeInstanceOf(LocationRouteProvider);
  });

  it('falta o es inválido: falla con mensaje en español', () => {
    expect(() => createRouteProvider({}, deps)).toThrow(/ROUTE_PROVIDER/);
    expect(() => createRouteProvider({ ROUTE_PROVIDER: '' }, deps)).toThrow(/ROUTE_PROVIDER/);
    expect(() => createRouteProvider({ ROUTE_PROVIDER: 'google' }, deps)).toThrow(
      /location.*haversine|haversine.*location/,
    );
    expect(() => createRouteProvider({ ROUTE_PROVIDER: 'Location' }, deps)).toThrow(
      /ROUTE_PROVIDER/,
    );
  });
});

describe('GEO_ROUTES_CLIENT_CONFIG (tiempos de espera)', () => {
  it('vence antes que el timeout de 10 s de la Lambda: 3 s de petición, 1 s de conexión, 2 intentos', () => {
    expect(GEO_ROUTES_CLIENT_CONFIG.maxAttempts).toBe(2);
    expect(GEO_ROUTES_CLIENT_CONFIG.requestHandler).toEqual({
      requestTimeout: 3000,
      connectionTimeout: 1000,
    });
    // Peor caso: 2 × (1 s + 3 s) = 8 s < 10 s de la Lambda (sin contar la espera entre intentos).
    const { requestTimeout, connectionTimeout } = GEO_ROUTES_CLIENT_CONFIG.requestHandler;
    expect(2 * (requestTimeout + connectionTimeout)).toBeLessThan(10_000);
  });

  it('el cliente real del SDK acepta esa configuración', async () => {
    const client = new GeoRoutesClient({ region: 'us-east-1', ...GEO_ROUTES_CLIENT_CONFIG });
    expect(await client.config.maxAttempts()).toBe(2);
    client.destroy();
  });
});

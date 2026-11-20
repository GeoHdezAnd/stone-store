// Soporte de pruebas (no se exporta desde el índice del paquete). Datos de EJEMPLO.
import type { Quote } from './schema';

export function sampleQuote(over: Partial<Quote> = {}): Quote {
  return {
    quoteId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    folio: 'CN-2026-00042',
    createdAt: '2026-11-19T10:00:00.000Z',
    status: 'cotizada',
    customer: { nombre: 'Cliente Ejemplo', telefono: '555-0100', correo: 'cliente@example.com' },
    works: { lugar: 'San Andrés Cholula', codigoPostal: '72810', uso: 'Fachada', notas: '' },
    items: [
      {
        stoneId: 'arenisca',
        nombre: 'Arenisca',
        acabado: 'Labrado',
        cantidad: 10.5,
        unidad: 'm2',
        pesoKg: 1200,
      },
      {
        stoneId: 'caliza',
        nombre: 'Caliza',
        acabado: '',
        cantidad: 3,
        unidad: 'pieza',
        pesoKg: 90,
      },
    ],
    freight: {
      estimadoMin: 1400,
      estimadoMax: 1700,
      moneda: 'MXN',
      pesoTotalKg: 1290,
      distanciaKm: 62,
      camion: 'Camioneta',
      viajes: 1,
      versionTarifa: 't0001',
      calculadoAt: '2026-11-19T10:00:00.000Z',
    },
    finalQuote: {
      items: [
        { stoneId: 'arenisca', precioUnitario: 120.1, subtotal: 1261.05 },
        { stoneId: 'caliza', precioUnitario: 0.1, subtotal: 0.3 },
      ],
      fleteFinal: 1500.05,
      subtotal: 1261.35,
      iva: null,
      ivaPct: null,
      total: 2761.4,
      vigenciaDias: 15,
    },
    history: [],
    notes: [],
    consentAt: '2026-11-19T10:00:00.000Z',
    rev: 1,
    ejemplo: true,
    ...over,
  };
}

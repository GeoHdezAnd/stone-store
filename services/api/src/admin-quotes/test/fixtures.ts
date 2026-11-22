// Datos de EJEMPLO para las pruebas (solo soporte de tests; no se empaqueta en la Lambda).
import { computeFinalQuote, type Quote } from '@canteras/shared';

export const ID_A = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
export const ID_B = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
export const ID_C = '01ARZ3NDEKTSV4RRFFQ69G5FAX';

export function quote(over: Partial<Quote> = {}): Quote {
  return {
    quoteId: ID_A,
    folio: 'CN-2026-00001',
    createdAt: '2026-11-10T10:00:00.000Z',
    status: 'nueva',
    customer: { nombre: 'María Pérez', telefono: '555-0101', correo: 'maria@example.com' },
    works: { lugar: 'San Andrés Cholula', codigoPostal: '72810', uso: 'Fachada', notas: '' },
    items: [
      {
        stoneId: 'arenisca',
        nombre: 'Arenisca',
        acabado: 'Labrado',
        cantidad: 10,
        unidad: 'm2',
        pesoKg: 1100,
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
    history: [],
    notes: [],
    consentAt: '2026-11-10T10:00:00.000Z',
    rev: 1,
    ejemplo: true,
    ...over,
  };
}

/** Precios válidos para `quote()` (arenisca 10 m² y caliza 3 piezas). */
export const PRICES = {
  items: [
    { stoneId: 'arenisca', precioUnitario: 120.5 },
    { stoneId: 'caliza', precioUnitario: 300 },
  ],
  fleteFinal: 1500,
};
// 10 × 120.50 + 3 × 300 = 2105.00 ; total = 3605.00

export const PUBLIC_ROW = {
  key: 'PUBLIC',
  nombrePatio: 'Canteras Naturales (ejemplo)',
  direccion: 'Dirección de ejemplo',
  lat: 19.1,
  lng: -97.62,
  horario: 'Lunes a sábado, 8:00 a 17:00 (ejemplo)',
  whatsapp: '525500000000',
  correoRemitente: 'ventas@example.com',
};
export const MAIL_ROW = {
  key: 'MAIL',
  asuntoCotizacion: 'Tu cotización {{folio}} de Canteras Naturales',
  plantillaCotizacion:
    'Hola {{nombre}},\n\nTu cotización {{folio}}.\n\nPiedras:\n{{piedras}}\nFlete: {{flete}}\nTotal: {{total}}\n\nVigencia: {{vigencia}}.',
};

/** Solicitud `cotizada` con su cotización final calculada (PRICES). */
export function quotedQuote(over: Partial<Quote> = {}): Quote {
  const base = quote();
  return quote({
    status: 'cotizada',
    finalQuote: computeFinalQuote({
      items: base.items,
      prices: PRICES.items,
      fleteFinal: PRICES.fleteFinal,
      vigenciaDias: 15,
    }),
    ...over,
  });
}

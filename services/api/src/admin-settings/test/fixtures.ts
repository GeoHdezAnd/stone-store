// Datos de EJEMPLO válidos para las pruebas (solo soporte de tests; no se empaqueta en la Lambda).
import type { MailSettings, PublicSettings, QuotingSettings } from '@canteras/shared';

export function publicSettings(over: Record<string, unknown> = {}): PublicSettings {
  return {
    nombrePatio: 'Patio de ejemplo',
    direccion: 'Calle de ejemplo 1, San Salvador el Seco, Puebla',
    lat: 19.1,
    lng: -97.62,
    horario: 'Lunes a sábado, 8:00 a 17:00',
    whatsapp: '525512345678',
    correoRemitente: 'ventas@ejemplo.test',
    ...over,
  } as PublicSettings;
}

export function mailSettings(over: Record<string, unknown> = {}): MailSettings {
  return {
    asuntoCotizacion: 'Tu cotización {{folio}}',
    plantillaCotizacion: 'Hola {{nombre}}, folio {{folio}}, total {{total}}.',
    ...over,
  } as MailSettings;
}

export function quotingSettings(over: Record<string, unknown> = {}): QuotingSettings {
  return { ivaPctDefault: 16, ...over } as QuotingSettings;
}

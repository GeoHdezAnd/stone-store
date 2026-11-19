// Errores tipados del cálculo de flete. Dominio puro: sin I/O.
// Los mensajes van en español, son seguros para mostrarse al cliente y NO reproducen
// datos enviados (ids, CP, etc.).

export const FREIGHT_ERROR_CODES = [
  'invalid_postal_code', // CP con formato inválido -> 400
  'out_of_zone', // CP fuera de zonasCubiertas o distancia > maxKm -> 422
  'invalid_distance', // distancia no finita o negativa
  'invalid_items', // lista vacía o demasiado larga -> 400
  'invalid_quantity', // cantidad <= 0, NaN, Infinity, sobre el tope o pieza no entera -> 400
  'unknown_stone', // stoneId inexistente -> 400
  'inactive_stone', // piedra dada de baja -> 400
  'unit_not_sold', // unidad no permitida por vendidaPor -> 400
  'thickness_not_available', // espesor ausente o fuera de espesoresCm -> 400
  'too_large', // peso total o viajes sobre el tope -> 422 «consúltenos por WhatsApp»
] as const;
export type FreightErrorCode = (typeof FREIGHT_ERROR_CODES)[number];

export class FreightError extends Error {
  readonly code: FreightErrorCode;

  constructor(code: FreightErrorCode, message: string) {
    super(message);
    this.name = 'FreightError';
    this.code = code;
  }
}

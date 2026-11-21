import type { Stone } from '../catalog/stone';
import { FREIGHT_ERROR_CODES, FreightError, type FreightErrorCode } from '../freight/errors';
import type { FreightConfig } from '../freight/config';
import { computeWeightKg, type FreightItem } from '../freight/weight';
import type { CreateQuoteRequest } from './create-request';
import { quoteSchema, type Quote } from './schema';
import { quoteIndexKeys } from './search';

// Arma la solicitud `nueva` a partir de lo que mandó el navegador (ya validado) y de lo que el
// SERVIDOR sabe: catálogo, tarifa activa, reloj e identificadores. Dominio puro: sin I/O. Nada que
// afecte al negocio (nombre de piedra, peso, estado, fechas, folio) viene del cliente.

export const NEW_QUOTE_ERROR_CODES = [...FREIGHT_ERROR_CODES, 'invalid_finish'] as const;
export type NewQuoteErrorCode = FreightErrorCode | 'invalid_finish';

/** Error de dominio: el pedido no se puede aceptar. El mensaje es seguro para mostrarse (sin eco). */
export class NewQuoteError extends Error {
  readonly code: NewQuoteErrorCode;

  constructor(code: NewQuoteErrorCode, message: string) {
    super(message);
    this.name = 'NewQuoteError';
    this.code = code;
  }
}

export interface NewQuoteSource {
  userAgent?: string | undefined;
  referrer?: string | undefined;
}

export interface NewQuoteInput {
  request: CreateQuoteRequest;
  /** Piedras encontradas en el catálogo (las que no existan simplemente no vienen). */
  stones: readonly Stone[];
  /** Tarifa ACTIVA: de ella sale la merma con la que se calcula el peso. */
  freight: Pick<FreightConfig, 'mermaPct'>;
  now: Date;
  quoteId: string;
  folio: string;
  source: NewQuoteSource;
}

export type NewQuoteRecord = {
  /** Documento de dominio (pasa `quoteSchema`). */
  quote: Quote;
  /** Lo que se guarda: el documento más las claves de índice y de búsqueda. */
  item: Quote & ReturnType<typeof quoteIndexKeys>;
};

const MAX_USER_AGENT = 200;
const MAX_REFERRER = 300;
// Caracteres de control y de dirección: se vuelven un espacio (son datos de un encabezado HTTP).
const CONTROL_RE = /[\p{Cc}\p{Cf}\s]+/gu;

function cleanHeader(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  const clean = value.replace(CONTROL_RE, ' ').trim().slice(0, max);
  return clean === '' ? undefined : clean;
}

/** El referrer puede traer datos personales en la query (`?correo=...`): solo se guarda origen y ruta. */
function cleanReferrer(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return cleanHeader(value.replace(/[?#].*$/s, ''), MAX_REFERRER);
}

function buildSource(source: NewQuoteSource): Quote['source'] {
  const userAgent = cleanHeader(source.userAgent, MAX_USER_AGENT);
  const referrer = cleanReferrer(source.referrer);
  if (userAgent === undefined && referrer === undefined) return undefined;
  return {
    ...(userAgent === undefined ? {} : { userAgent }),
    ...(referrer === undefined ? {} : { referrer }),
  };
}

/** El peso lo calcula `computeWeightKg`; sus errores se traducen al error de dominio de la solicitud. */
function weightOrThrow(
  items: readonly FreightItem[],
  stones: readonly Stone[],
  freight: Pick<FreightConfig, 'mermaPct'>,
): number {
  try {
    return computeWeightKg(items, stones, freight);
  } catch (err) {
    if (err instanceof FreightError) throw new NewQuoteError(err.code, err.message);
    throw err;
  }
}

export function buildNewQuote(input: NewQuoteInput): NewQuoteRecord {
  const { request, stones, freight, now, quoteId, folio } = input;
  const byId = new Map(stones.map((s) => [s.id, s]));

  const items: Quote['items'] = request.items.map((req) => {
    const freightItem: FreightItem = {
      stoneId: req.stoneId,
      cantidad: req.cantidad,
      unidad: req.unidad,
      ...(req.espesorCm === undefined ? {} : { espesorCm: req.espesorCm }),
    };
    // Valida existencia, baja lógica, unidad vendida, espesor y cantidad, y da el peso con merma.
    const pesoKg = weightOrThrow([freightItem], stones, freight);
    const stone = byId.get(req.stoneId) as Stone; // computeWeightKg ya comprobó que existe
    const acabado = req.acabado ?? '';
    if (acabado !== '' && !stone.acabados.includes(acabado)) {
      throw new NewQuoteError(
        'invalid_finish',
        'El acabado indicado no está disponible para una de las piedras.',
      );
    }
    return {
      stoneId: stone.id,
      nombre: stone.nombre,
      acabado,
      cantidad: req.cantidad,
      unidad: req.unidad,
      pesoKg,
    };
  });

  // El tope de peso también vale para el pedido completo, no solo por renglón.
  weightOrThrow(
    request.items.map((r) => ({
      stoneId: r.stoneId,
      cantidad: r.cantidad,
      unidad: r.unidad,
      ...(r.espesorCm === undefined ? {} : { espesorCm: r.espesorCm }),
    })),
    stones,
    freight,
  );

  const createdAt = now.toISOString();
  const source = buildSource(input.source);
  // El esquema final es la última barrera: un quoteId o folio mal formados no se guardan.
  const quote = quoteSchema.parse({
    quoteId,
    folio,
    createdAt,
    status: 'nueva',
    customer: { ...request.customer },
    works: { ...request.works },
    items,
    history: [],
    notes: [],
    consentAt: createdAt,
    ...(source === undefined ? {} : { source }),
    rev: 1,
  });
  return { quote, item: { ...quote, ...quoteIndexKeys(quote) } };
}

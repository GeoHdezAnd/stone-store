import { ULID_PATTERN, type QuoteStatus } from '@canteras/shared';
import { z } from 'zod';
import type { QuoteKey } from './repository';

// Cursor opaco = base64url(JSON de la clave de continuación de Dynamo). Viene del cliente: NUNCA
// se pasa a DynamoDB sin validar. Está atado al índice, al estado y al rango de fechas de la consulta: un cursor
// de otra lista no sirve. Se valida con esquemas estrictos y sin lanzar errores.
const SK_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z#[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_CURSOR_CHARS = 512;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

const ulid = z.string().regex(ULID_PATTERN);
const sk = z.string().regex(SK_RE);

const dateKey = z.strictObject({ quoteId: ulid, gsi2pk: z.literal('QUOTE'), gsi2sk: sk });
const statusKey = (status: QuoteStatus) =>
  z.strictObject({ quoteId: ulid, gsi1pk: z.literal(`STATUS#${status}`), gsi1sk: sk });

export function encodeCursor(key: QuoteKey): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

/** Devuelve la clave de inicio o `null` si el cursor no es válido para esta consulta. */
export function decodeCursor(
  raw: string,
  query: { status?: QuoteStatus; from?: string; to?: string },
): QuoteKey | null {
  if (raw.length === 0 || raw.length > MAX_CURSOR_CHARS || !BASE64URL_RE.test(raw)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    const schema = query.status === undefined ? dateKey : statusKey(query.status);
    const result = schema.safeParse(parsed);
    if (!result.success) return null;
    const key = result.data as Record<string, string>;
    // El `sk` debe terminar en el mismo quoteId (clave coherente).
    const sortKey = (key['gsi1sk'] ?? key['gsi2sk']) as string;
    if (!sortKey.endsWith(`#${key['quoteId']}`)) return null;
    // Atado también al rango de fechas de la consulta (`to` ya trae el sufijo `#~`).
    if (query.from !== undefined && sortKey < query.from) return null;
    if (query.to !== undefined && sortKey > query.to) return null;
    return key;
  } catch {
    return null;
  }
}

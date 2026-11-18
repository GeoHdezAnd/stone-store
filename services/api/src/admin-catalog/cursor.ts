import { idSchema } from '@canteras/shared';
import { z } from 'zod';

// Cursor opaco de paginación: base64url(JSON {id}). Viene del cliente, así que NUNCA se pasa
// a DynamoDB sin validarlo: se decodifica con try/catch y se valida con un esquema estricto.
const cursorSchema = z.strictObject({ id: idSchema });
const MAX_CURSOR_CHARS = 512;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export type CursorKey = z.infer<typeof cursorSchema>;

export function encodeCursor(id: string): string {
  return Buffer.from(JSON.stringify({ id }), 'utf8').toString('base64url');
}

/** Devuelve la clave de inicio o `null` si el cursor no es válido (cualquier motivo). */
export function decodeCursor(raw: string): CursorKey | null {
  if (raw.length === 0 || raw.length > MAX_CURSOR_CHARS || !BASE64URL_RE.test(raw)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    const result = cursorSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

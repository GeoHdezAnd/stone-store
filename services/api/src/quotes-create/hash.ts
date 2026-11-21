import { createHash } from 'node:crypto';

/** sha256 en hexadecimal minúscula (64 caracteres). Las claves del límite nunca llevan PII en claro. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

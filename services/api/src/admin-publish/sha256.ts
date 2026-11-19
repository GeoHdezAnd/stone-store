import { createHash } from 'node:crypto';
import type { Sha256Hex } from '@canteras/shared';

/** sha-256 hexadecimal (el `shared` no puede importar `node:crypto`, por eso se inyecta). */
export const sha256Hex: Sha256Hex = (texto) =>
  createHash('sha256').update(texto, 'utf8').digest('hex');

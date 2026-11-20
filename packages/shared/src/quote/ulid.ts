// ULID (26 caracteres Crockford base32, ordenable por tiempo). Puro: el tiempo y el azar se
// inyectan (shared no usa Node ni `crypto`). En producción `random` debe ser criptográfico.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isUlid(value: unknown): value is string {
  return typeof value === 'string' && ULID_PATTERN.test(value);
}

const MAX_TIME = 2 ** 48 - 1;

/** `timeMs` en ms desde epoch; `random()` devuelve un número en [0, 1). */
export function generateUlid(timeMs: number, random: () => number): string {
  if (!Number.isInteger(timeMs) || timeMs < 0 || timeMs > MAX_TIME) {
    throw new RangeError('ULID: tiempo fuera de rango.');
  }
  let time = '';
  let t = timeMs;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let rand = '';
  for (let i = 0; i < 16; i++) {
    const r = random();
    rand += ALPHABET[Math.min(31, Math.max(0, Math.floor(r * 32)))];
  }
  return time + rand;
}

/** Milisegundos codificados en un ULID válido. */
export function ulidTime(ulid: string): number {
  if (!isUlid(ulid)) throw new RangeError('ULID inválido.');
  let t = 0;
  for (const c of ulid.slice(0, 10)) t = t * 32 + ALPHABET.indexOf(c);
  return t;
}

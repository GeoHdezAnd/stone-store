// Encabezados de correo seguros (una sola línea, RFC 2047). Dominio puro: sin I/O.

/**
 * Una sola línea: los caracteres de control (\p{Cc}, p. ej. U+0085) y de formato (\p{Cf}, p. ej. los
 * de dirección U+202E/U+200F que invierten el texto) y los saltos de línea se vuelven un espacio.
 */
export const oneLine = (s: string): string => s.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim();

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 de bytes UTF-8 (sin `btoa`/`Buffer`: shared es isomórfico). */
function base64Utf8(text: string): string {
  const bytes: number[] = [];
  for (const m of encodeURIComponent(text).matchAll(/%([0-9A-F]{2})|([^%])/g)) {
    bytes.push(m[1] !== undefined ? parseInt(m[1], 16) : (m[2] as string).charCodeAt(0));
  }
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b, c] = [bytes[i] as number, bytes[i + 1], bytes[i + 2]];
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? '=' : B64[c & 63];
  }
  return out;
}

const utf8Length = (ch: string): number =>
  encodeURIComponent(ch).replace(/%[0-9A-F]{2}/g, '.').length;

/** Palabras codificadas RFC 2047 de a lo más 45 bytes (72 caracteres), sin partir un carácter. */
function encodedWords(name: string): string {
  const words: string[] = [];
  let chunk = '';
  let bytes = 0;
  for (const ch of name) {
    const n = utf8Length(ch);
    if (bytes + n > 45) {
      words.push(chunk);
      chunk = '';
      bytes = 0;
    }
    chunk += ch;
    bytes += n;
  }
  if (chunk !== '') words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${base64Utf8(w)}?=`).join(' ');
}

/**
 * Encabezado From. Nombre ASCII: entre comillas con `"` y `\` escapados. Con acentos, emoji u otros
 * no ASCII: RFC 2047 (`=?UTF-8?B?...?=`), que es lo que SES y los clientes de correo esperan.
 */
export function fromHeader(name: string, address: string): string {
  const clean = oneLine(name);
  if (clean === '') return address;
  if (/^[\x20-\x7e]+$/.test(clean)) {
    return `"${clean.replace(/[\\"]/g, '\\$&')}" <${address}>`;
  }
  return `${encodedWords(clean)} <${address}>`;
}

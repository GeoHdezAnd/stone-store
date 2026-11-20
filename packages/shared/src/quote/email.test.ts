import { describe, expect, it } from 'vitest';
import { mailSettingsSchema, publicSettingsSchema } from '../catalog/settings';
import { buildQuoteEmail, isValidRecipient, maskEmail } from './email';
import { sampleQuote } from './test-fixtures';

const mailSettings = mailSettingsSchema.parse({
  asuntoCotizacion: 'Tu cotización {{folio}} de Canteras Naturales',
  plantillaCotizacion:
    'Hola {{nombre}},\n\nTu cotización {{folio}}.\n\nPiedras:\n{{piedras}}\nFlete: {{flete}}\nTotal: {{total}}\n\nVigencia: {{vigencia}}.\n\nSaludos',
});
const publicSettings = publicSettingsSchema.parse({
  nombrePatio: 'Canteras Naturales (ejemplo)',
  direccion: 'Dirección de ejemplo',
  lat: 19.1,
  lng: -97.62,
  horario: 'Lunes a sábado, 8:00 a 17:00 (ejemplo)',
  whatsapp: '525500000000',
  correoRemitente: 'ventas@example.com',
});
const sentAt = new Date('2026-11-19T18:00:00.000Z');
const build = (over = {}, ms = mailSettings, ps = publicSettings) =>
  buildQuoteEmail({ quote: sampleQuote(over), mailSettings: ms, publicSettings: ps, sentAt });

describe('buildQuoteEmail', () => {
  it('arma from, to, asunto, texto y html', () => {
    const m = build();
    expect(m.from).toBe('"Canteras Naturales (ejemplo)" <ventas@example.com>');
    expect(m.to).toBe('cliente@example.com');
    expect(m.subject).toBe('Tu cotización CN-2026-00042 de Canteras Naturales');
    expect(m.text).toContain('Hola Cliente Ejemplo,');
    expect(m.html).toContain('Hola Cliente Ejemplo,');
  });

  it('formatea dinero en MXN es-MX, con renglones y «sin IVA»', () => {
    const { text } = build();
    expect(text).toContain('Arenisca (Labrado): 10.5 m² × $120.10 = $1,261.05');
    expect(text).toContain('Caliza: 3 pieza(s) × $0.10 = $0.30');
    expect(text).toContain('Flete: $1,500.05 MXN');
    expect(text).toContain('Total: $2,761.40 MXN (sin IVA)');
  });

  it('vigencia en días y fecha de vencimiento (México)', () => {
    expect(build().text).toContain('Vigencia: 15 días, hasta el 4 de diciembre de 2026.');
    const q = sampleQuote();
    const m = buildQuoteEmail({
      quote: { ...q, finalQuote: { ...q.finalQuote!, vigenciaDias: 1 } },
      mailSettings,
      publicSettings,
      sentAt,
    });
    expect(m.text).toContain('1 día, hasta el 20 de noviembre de 2026');
  });

  it('agrega el aviso de importes y el pie del patio', () => {
    const { text } = build();
    expect(text).toContain('no incluyen IVA');
    expect(text).toContain('Horario: Lunes a sábado, 8:00 a 17:00 (ejemplo)');
  });

  it('NUNCA incluye notas internas, historial, motivo de pérdida ni el estimado automático', () => {
    const m = build({
      notes: [{ at: '2026-11-19T10:00:00.000Z', by: 'u', texto: 'SECRETO-NOTA' }],
      history: [{ at: '2026-11-19T10:00:00.000Z', by: 'u', tipo: 'nota', texto: 'SECRETO-HIST' }],
      lostReason: 'precio_flete',
    });
    for (const s of [m.subject, m.text, m.html]) {
      expect(s).not.toContain('SECRETO');
      expect(s).not.toContain('precio_flete');
      expect(s).not.toContain('1,400.00'); // estimadoMin
      expect(s).not.toContain('1,700.00'); // estimadoMax
    }
  });

  it('escapa HTML en todo dato del cliente (html) pero no en el texto plano', () => {
    const q = sampleQuote();
    const m = buildQuoteEmail({
      quote: {
        ...q,
        customer: { ...q.customer, nombre: '<script>alert(1)</script>' },
        items: [
          { ...q.items[0]!, nombre: '<img src=x onerror=alert(1)>', acabado: 'A&B' },
          q.items[1]!,
        ],
      },
      mailSettings,
      publicSettings,
      sentAt,
    });
    expect(m.html).not.toContain('<script>');
    expect(m.html).not.toContain('<img');
    expect(m.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(m.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(m.html).toContain('A&amp;B');
    expect(m.text).toContain('<script>alert(1)</script>'); // texto plano: sin escape
  });

  it('escapa también el texto literal de la plantilla en el html', () => {
    const ms = mailSettingsSchema.parse({
      ...mailSettings,
      plantillaCotizacion: 'Hola <b>{{nombre}}</b> & {{total}}',
    });
    expect(build({}, ms).html).toContain('Hola &lt;b&gt;Cliente Ejemplo&lt;/b&gt; &amp; ');
  });

  it('neutraliza saltos de línea en el asunto, el remitente y el destinatario (inyección de cabeceras)', () => {
    const q = sampleQuote();
    const ms = mailSettingsSchema.parse({
      ...mailSettings,
      asuntoCotizacion: '{{nombre}} {{piedras}}',
    });
    const ps = publicSettingsSchema.parse({
      ...publicSettings,
      nombrePatio: 'Patio\r\nBcc: x@evil.com',
    });
    const m = buildQuoteEmail({
      quote: { ...q, customer: { ...q.customer, nombre: 'Ana\r\nBcc: evil@example.com' } },
      mailSettings: ms,
      publicSettings: ps,
      sentAt,
    });
    for (const h of [m.subject, m.from, m.to]) expect(h).not.toMatch(/[\r\n]/);
    expect(m.text).not.toMatch(/Ana\r/);
  });

  it('rechaza correos destinatario con separadores o saltos de línea', () => {
    const q = sampleQuote();
    for (const correo of [
      'a@example.com,b@example.com',
      'a@example.com\nbcc:x@y.com',
      'a b@example.com',
    ]) {
      expect(() =>
        buildQuoteEmail({
          quote: { ...q, customer: { ...q.customer, correo } },
          mailSettings,
          publicSettings,
          sentAt,
        }),
      ).toThrow(/destinatario/i);
    }
  });

  it('rechaza plantillas con variables desconocidas', () => {
    const bad = { asuntoCotizacion: '{{secreto}}', plantillaCotizacion: 'x' } as never;
    expect(() => build({}, bad)).toThrow();
    const bad2 = { asuntoCotizacion: 'x', plantillaCotizacion: 'Hola {{notas}}' } as never;
    expect(() => build({}, bad2)).toThrow();
  });

  it('exige finalQuote completo (un precio por piedra)', () => {
    const q = sampleQuote();
    const sin = { ...q };
    delete (sin as { finalQuote?: unknown }).finalQuote;
    expect(() => buildQuoteEmail({ quote: sin, mailSettings, publicSettings, sentAt })).toThrow(
      /cotización final/,
    );
    const mitad = { ...q, finalQuote: { ...q.finalQuote!, items: [q.finalQuote!.items[0]!] } };
    expect(() => buildQuoteEmail({ quote: mitad, mailSettings, publicSettings, sentAt })).toThrow(
      /cotización final/,
    );
  });
});

describe('maskEmail', () => {
  it('conserva la primera letra y el dominio', () => {
    expect(maskEmail('juan@dominio.com')).toBe('j***@dominio.com');
    expect(maskEmail('a@x.com')).toBe('a***@x.com');
  });
  it('un valor sin forma de correo se enmascara por completo', () => {
    expect(maskEmail('sin-arroba')).toBe('***');
    expect(maskEmail('')).toBe('***');
  });
});

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** Decodifica base64 -> UTF-8 sin `Buffer`/`atob` (shared no usa tipos de Node ni DOM). */
function decodeB64Utf8(b64: string): string {
  const bytes: number[] = [];
  let bits = 0;
  let acc = 0;
  for (const ch of b64.replace(/=+$/, '')) {
    acc = (acc << 6) | ALPHA.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 255);
    }
  }
  return decodeURIComponent(bytes.map((b) => `%${b.toString(16).padStart(2, '0')}`).join(''));
}

describe('encabezado From (RFC 2047)', () => {
  const ps = (nombrePatio: string) =>
    publicSettingsSchema.parse({ ...publicSettings, nombrePatio });
  const decode = (from: string): string => {
    const words = [...from.matchAll(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/g)].map((m) =>
      decodeB64Utf8(m[1]!),
    );
    return words.join('');
  };

  it('un nombre ASCII queda tal cual entre comillas', () => {
    expect(build({}, mailSettings, ps('Cantera Natural')).from).toBe(
      '"Cantera Natural" <ventas@example.com>',
    );
  });

  it('comillas y barras invertidas se escapan', () => {
    expect(build({}, mailSettings, ps('Cantera "La \\ Buena"')).from).toBe(
      '"Cantera \\"La \\\\ Buena\\"" <ventas@example.com>',
    );
  });

  it('un nombre con acentos se codifica =?UTF-8?B?...?= y decodifica igual', () => {
    const from = build({}, mailSettings, ps('Cantera Peña')).from;
    expect(from).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <ventas@example\.com>$/);
    expect(decode(from)).toBe('Cantera Peña');
  });

  it('con emoji y nombre largo: palabras codificadas de a lo más 75 caracteres, sin partir caracteres', () => {
    const nombre = 'Canteras Ñandú 🪨 ' + 'ó'.repeat(80);
    const from = build({}, mailSettings, ps(nombre)).from;
    const words = from.match(/=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/g)!;
    expect(words.length).toBeGreaterThan(1);
    for (const w of words) expect(w.length).toBeLessThanOrEqual(75);
    expect(decode(from)).toBe(nombre);
    expect(from).not.toMatch(/[\r\n]/);
  });
});

describe('caracteres de control y bidi en datos del correo', () => {
  it('U+202E, U+0085 y similares se quitan de nombre, piedra y patio', () => {
    const q = sampleQuote();
    const m = buildQuoteEmail({
      quote: {
        ...q,
        customer: { ...q.customer, nombre: 'Ana\u202Ebc\u0085d\u200Fe' },
        items: [
          { ...q.items[0]!, nombre: 'Are\u202Enisca\u0007', acabado: 'La\u0085brado' },
          q.items[1]!,
        ],
      },
      mailSettings,
      publicSettings: publicSettingsSchema.parse({
        ...publicSettings,
        nombrePatio: 'Pa\u202Etio',
        horario: 'H\u0085rs',
      }),
      sentAt,
    });
    for (const s of [m.subject, m.text, m.html, m.from]) {
      for (const ch of ['\u202E', '\u0085', '\u200F', '\u0007']) expect(s.includes(ch)).toBe(false);
    }
    expect(m.text).toContain('Hola Ana bc d e,');
  });
});

describe('isValidRecipient', () => {
  it('una sola dirección sin separadores', () => {
    expect(isValidRecipient('a@example.com')).toBe(true);
    for (const x of [
      'a@example.com,b@example.com',
      'a b@example.com',
      'a@example.com\n',
      '<a@example.com>',
      'sin-arroba',
    ]) {
      expect(isValidRecipient(x)).toBe(false);
    }
  });
});

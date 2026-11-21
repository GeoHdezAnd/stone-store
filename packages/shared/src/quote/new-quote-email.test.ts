import { describe, expect, it } from 'vitest';
import { publicSettingsSchema } from '../catalog/settings';
import { buildCustomerConfirmationEmail, buildOwnerNotificationEmail } from './new-quote-email';
import { sampleQuote } from './test-fixtures';

const publicSettings = publicSettingsSchema.parse({
  nombrePatio: 'Canteras Naturales (ejemplo)',
  direccion: 'Dirección de ejemplo',
  lat: 19.1,
  lng: -97.62,
  horario: 'Lunes a sábado, 8:00 a 17:00 (ejemplo)',
  whatsapp: '525500000000',
  correoRemitente: 'ventas@example.com',
});

// Solicitud `nueva`: sin precios ni cotización final.
function nueva(over: Record<string, unknown> = {}) {
  const base = sampleQuote({ status: 'nueva' });
  delete base.finalQuote;
  delete base.freight;
  return { ...base, ...over } as ReturnType<typeof sampleQuote>;
}

describe('buildCustomerConfirmationEmail', () => {
  const m = buildCustomerConfirmationEmail({ quote: nueva(), publicSettings });

  it('va del patio al cliente, con el folio en el asunto', () => {
    expect(m.from).toBe('"Canteras Naturales (ejemplo)" <ventas@example.com>');
    expect(m.to).toBe('cliente@example.com');
    expect(m.subject).toBe('Recibimos tu solicitud de cotización CN-2026-00042');
  });

  it('el texto trae folio, saludo, piedras con cantidad y unidad, lugar y CP', () => {
    expect(m.text).toContain('Hola Cliente Ejemplo,');
    expect(m.text).toContain('CN-2026-00042');
    expect(m.text).toContain('Arenisca (Labrado): 10.5 m²');
    expect(m.text).toContain('Caliza: 3 pieza(s)');
    expect(m.text).toContain('San Andrés Cholula');
    expect(m.text).toContain('72810');
  });

  it('promete respuesta en menos de 48 h y aclara que precios y flete se confirman en la cotización', () => {
    expect(m.text).toMatch(/menos de 48 horas/);
    expect(m.text).toMatch(/precios y el flete se confirman en la cotización/);
    expect(m.html).toMatch(/menos de 48 horas/);
  });

  it('NO incluye precios, totales ni estimado de flete', () => {
    for (const parte of [m.text, m.html, m.subject]) {
      expect(parte).not.toMatch(/\$\s?\d/);
      expect(parte).not.toMatch(/MXN/);
    }
  });

  it('pie con horario y enlace de WhatsApp del patio', () => {
    expect(m.text).toContain('Horario: Lunes a sábado, 8:00 a 17:00 (ejemplo)');
    expect(m.text).toContain('https://wa.me/525500000000');
  });

  it('NUNCA incluye notas internas ni historial', () => {
    const q = nueva({
      notes: [{ at: '2026-11-19T10:00:00.000Z', by: 'u', texto: 'NOTA-INTERNA-SECRETA' }],
      history: [
        { at: '2026-11-19T10:00:00.000Z', by: 'u', tipo: 'nota', texto: 'HISTORIAL-SECRETO' },
      ],
    });
    const mm = buildCustomerConfirmationEmail({ quote: q, publicSettings });
    for (const parte of [mm.text, mm.html]) {
      expect(parte).not.toContain('NOTA-INTERNA-SECRETA');
      expect(parte).not.toContain('HISTORIAL-SECRETO');
    }
  });

  it('el texto plano NO escapa (un & queda como &) y el HTML sí', () => {
    const q = nueva({
      works: { lugar: 'Tom & Jerry <obra>', codigoPostal: '72810', uso: '', notas: '' },
    });
    const mm = buildCustomerConfirmationEmail({ quote: q, publicSettings });
    expect(mm.text).toContain('Tom & Jerry <obra>');
    expect(mm.html).toContain('Tom &amp; Jerry &lt;obra&gt;');
    expect(mm.html).not.toContain('<obra>');
  });
});

describe('escape y cabeceras (cliente hostil)', () => {
  const hostil = {
    customer: {
      nombre: '<script>alert(1)</script>"\'&',
      telefono: '555-0101',
      correo: 'cliente@example.com',
    },
    works: {
      lugar: '<img src=x onerror=alert(1)>',
      codigoPostal: '72810',
      uso: '"><svg onload=x>',
      notas: 'Hola\n<b>negrita</b>\nTercera línea & más',
    },
    items: [
      {
        stoneId: 'a',
        nombre: '<i>Piedra</i>',
        acabado: '"Fino"',
        cantidad: 1,
        unidad: 'm2' as const,
        pesoKg: 10,
      },
    ],
  };
  const quote = nueva(hostil);

  it('confirmación: el HTML escapa TODO valor del cliente', () => {
    const { html } = buildCustomerConfirmationEmail({ quote, publicSettings });
    expect(html).not.toMatch(/<script|<img|<svg|<i>|<b>/);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&amp;');
    expect(html).toContain('&lt;i&gt;Piedra&lt;/i&gt;');
    expect(html).toContain('&quot;Fino&quot;');
  });

  it('aviso al dueño: el HTML escapa todo, incluidas notas, y conserva los saltos con <br>', () => {
    const { html } = buildOwnerNotificationEmail({ quote, publicSettings });
    expect(html).not.toMatch(/<script|<img|<svg|<i>|<b>/);
    expect(html).toContain('Hola<br>\n&lt;b&gt;negrita&lt;/b&gt;<br>\nTercera línea &amp; más');
    expect(html).toContain('&quot;&gt;&lt;svg onload=x&gt;');
  });

  it('un nombre con saltos de línea no inyecta cabeceras en asunto, remitente ni destinatario', () => {
    const q = nueva({
      customer: {
        nombre: 'Ana\r\nBcc: espia@evil.example‮',
        telefono: '555-0101',
        correo: 'cliente@example.com',
      },
    });
    for (const m of [
      buildCustomerConfirmationEmail({ quote: q, publicSettings }),
      buildOwnerNotificationEmail({ quote: q, publicSettings }),
    ]) {
      for (const h of [m.subject, m.from, m.to]) {
        expect(h).not.toMatch(/[\r\n‮\u0085]/);
      }
    }
    const owner = buildOwnerNotificationEmail({ quote: q, publicSettings });
    expect(owner.subject).toBe('Nueva solicitud CN-2026-00042: Ana Bcc: espia@evil.example');
  });

  it('el nombre del patio con saltos o comillas no rompe el remitente', () => {
    const ps = { ...publicSettings, nombrePatio: 'Patio "Uno"\r\nBcc: x@evil.example' };
    const m = buildCustomerConfirmationEmail({ quote: nueva(), publicSettings: ps });
    expect(m.from).toBe('"Patio \\"Uno\\" Bcc: x@evil.example" <ventas@example.com>');
    expect(m.from).not.toMatch(/[\r\n]/);
  });

  it('un nombre de patio con acentos usa RFC 2047', () => {
    const ps = { ...publicSettings, nombrePatio: 'Cantería Ñandú' };
    expect(buildCustomerConfirmationEmail({ quote: nueva(), publicSettings: ps }).from).toMatch(
      /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <ventas@example\.com>$/,
    );
  });

  it('un destinatario con coma o espacios se rechaza (un solo destinatario)', () => {
    for (const correo of ['a@example.com,b@example.com', 'a b@example.com', '<a@example.com>']) {
      const q = nueva({ customer: { nombre: 'A', telefono: '555-0101', correo } });
      expect(() => buildCustomerConfirmationEmail({ quote: q, publicSettings })).toThrow();
    }
  });

  it('configuración del patio inválida: lanza', () => {
    const ps = { ...publicSettings, correoRemitente: 'no-correo' };
    expect(() => buildCustomerConfirmationEmail({ quote: nueva(), publicSettings: ps })).toThrow();
    expect(() => buildOwnerNotificationEmail({ quote: nueva(), publicSettings: ps })).toThrow();
  });
});

describe('buildOwnerNotificationEmail', () => {
  const q = nueva({
    works: {
      lugar: 'San Andrés Cholula',
      codigoPostal: '72810',
      uso: 'Fachada',
      notas: 'Entrega por la mañana.',
    },
  });

  it('va del patio a correoRemitente', () => {
    const m = buildOwnerNotificationEmail({ quote: q, publicSettings });
    expect(m.to).toBe('ventas@example.com');
    expect(m.from).toBe('"Canteras Naturales (ejemplo)" <ventas@example.com>');
    expect(m.subject).toBe('Nueva solicitud CN-2026-00042: Cliente Ejemplo');
  });

  it('incluye TODOS los datos del cliente y la obra, y las piedras', () => {
    const { text } = buildOwnerNotificationEmail({ quote: q, publicSettings });
    for (const dato of [
      'CN-2026-00042',
      'Cliente Ejemplo',
      '555-0100',
      'cliente@example.com',
      'San Andrés Cholula',
      '72810',
      'Fachada',
      'Entrega por la mañana.',
      'Arenisca (Labrado): 10.5 m²',
      'Caliza: 3 pieza(s)',
    ]) {
      expect(text, dato).toContain(dato);
    }
  });

  it('con adminBaseUrl: enlace al detalle /quotes/<quoteId> en texto y HTML', () => {
    const m = buildOwnerNotificationEmail({
      quote: q,
      publicSettings,
      adminBaseUrl: 'https://admin.ejemplo.mx',
    });
    const url = 'https://admin.ejemplo.mx/quotes/01ARZ3NDEKTSV4RRFFQ69G5FAV';
    expect(m.text).toContain(url);
    expect(m.html).toContain(`<a href="${url}">`);
  });

  it('quita las barras finales de adminBaseUrl', () => {
    const m = buildOwnerNotificationEmail({
      quote: q,
      publicSettings,
      adminBaseUrl: 'http://localhost:5173//',
    });
    expect(m.text).toContain('http://localhost:5173/quotes/01ARZ3NDEKTSV4RRFFQ69G5FAV');
  });

  it('sin adminBaseUrl: sin enlace (ni texto de enlace)', () => {
    const m = buildOwnerNotificationEmail({ quote: q, publicSettings });
    expect(m.text).not.toMatch(/https?:\/\//);
    expect(m.html).not.toContain('<a ');
    expect(m.text).not.toMatch(/\/quotes\//);
  });

  it.each([
    '',
    'javascript:alert(1)',
    'ftp://x.example',
    'https://a"b.example',
    'no es url',
    'https://x.example/<b>',
  ])('adminBaseUrl no válida (%s): no se genera enlace', (bad) => {
    const m = buildOwnerNotificationEmail({ quote: q, publicSettings, adminBaseUrl: bad });
    expect(m.text).not.toMatch(/\/quotes\//);
    expect(m.html).not.toContain('<a ');
    expect(m.html).not.toContain('javascript:');
  });

  it('sin notas dice que no hay notas (no deja el renglón vacío)', () => {
    const m = buildOwnerNotificationEmail({
      quote: nueva({ works: { lugar: 'x', codigoPostal: '72810', uso: '', notas: '' } }),
      publicSettings,
    });
    expect(m.text).toMatch(/Notas del cliente: \(sin notas\)/);
  });
});

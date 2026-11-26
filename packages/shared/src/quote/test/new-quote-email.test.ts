import { describe, expect, it } from 'vitest';
import { publicSettingsSchema } from '../../catalog/settings';
import { buildCustomerConfirmationEmail, buildOwnerNotificationEmail } from '../new-quote-email';
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

  it('el texto trae folio, saludo genérico y piedras con nombre del catálogo, cantidad y unidad', () => {
    expect(m.text.startsWith('Hola,\n')).toBe(true);
    expect(m.text).toContain('CN-2026-00042');
    expect(m.text).toContain('Arenisca (Labrado): 10.5 m²');
    expect(m.text).toContain('Caliza: 3 pieza(s)');
  });

  it('NO repite NADA del texto libre del cliente: ni nombre, ni lugar, ni CP, ni uso, ni notas, ni teléfono', () => {
    const q = nueva({
      customer: {
        nombre: 'NOMBRE-LIBRE Reactiva tu cuenta en https://evil.example/login',
        telefono: '5551234567',
        correo: 'cliente@example.com',
      },
      works: {
        lugar: 'LUGAR-LIBRE https://evil.example/pago',
        codigoPostal: '72810',
        uso: 'USO-LIBRE',
        notas: 'NOTAS-LIBRES paga el anticipo hoy',
      },
    });
    const mm = buildCustomerConfirmationEmail({ quote: q, publicSettings });
    for (const parte of [mm.text, mm.html, mm.subject, mm.from]) {
      for (const libre of [
        'NOMBRE-LIBRE',
        'LUGAR-LIBRE',
        'USO-LIBRE',
        'NOTAS-LIBRES',
        'evil.example',
        '5551234567',
        '72810',
      ]) {
        expect(parte, libre).not.toContain(libre);
      }
    }
    // Lo único con forma de enlace es el WhatsApp del patio.
    expect(mm.text.match(/https?:\/\/\S+/g)).toEqual(['https://wa.me/525500000000']);
    expect(mm.html.match(/https?:\/\/[^\s<"]+/g)).toEqual(['https://wa.me/525500000000']);
  });

  it('el pie trae los datos del patio: nombre, dirección, horario y WhatsApp', () => {
    expect(m.text).toContain('Canteras Naturales (ejemplo)');
    expect(m.text).toContain('Dirección: Dirección de ejemplo');
    expect(m.html).toContain('Dirección: Dirección de ejemplo');
  });

  it('aunque la solicitud traiga estimado de flete, el cliente NUNCA lo ve (lo revisa el dueño)', () => {
    const conEstimado = nueva({ freight: sampleQuote().freight });
    expect(conEstimado.freight).toBeDefined();
    const mm = buildCustomerConfirmationEmail({ quote: conEstimado, publicSettings });
    for (const parte of [mm.text, mm.html, mm.subject]) {
      expect(parte).not.toMatch(/estimado/i);
      expect(parte).not.toMatch(/1,400|1,700|1400|1700/);
      expect(parte).not.toMatch(/\$\s?\d/);
      expect(parte).not.toMatch(/MXN/);
    }
    expect(mm.text).toMatch(/este correo no incluye importes/);
    // El correo es idéntico con o sin estimado: no filtra si el cálculo existió.
    const sinEstimado = buildCustomerConfirmationEmail({ quote: nueva(), publicSettings });
    expect(mm.text).toBe(sinEstimado.text);
    expect(mm.html).toBe(sinEstimado.html);
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

  it('el texto plano NO escapa (un & queda como &) y el HTML sí (nombre de piedra)', () => {
    const q = nueva({
      items: [
        {
          stoneId: 'a',
          nombre: 'Tom & Jerry <piedra>',
          acabado: '',
          cantidad: 1,
          unidad: 'm2',
          pesoKg: 1,
        },
      ],
    });
    const mm = buildCustomerConfirmationEmail({ quote: q, publicSettings });
    expect(mm.text).toContain('Tom & Jerry <piedra>');
    expect(mm.html).toContain('Tom &amp; Jerry &lt;piedra&gt;');
    expect(mm.html).not.toContain('<piedra>');
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
    expect(html).not.toContain('alert(1)');
    expect(html).toContain('&lt;i&gt;Piedra&lt;/i&gt;');
    expect(html).toContain('&quot;Fino&quot;');
  });

  it('aviso al dueño: el HTML escapa todo, incluidas notas, y conserva los saltos con <br>', () => {
    const { html } = buildOwnerNotificationEmail({ quote, publicSettings });
    expect(html).not.toMatch(/<script|<img|<svg|<i>|<b>/);
    expect(html).toContain('Hola<br>\n&lt;b&gt;negrita&lt;/b&gt;<br>\nTercera línea &amp; más');
    expect(html).toMatch(/<blockquote[^>]*>Hola<br>/);
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

describe('buildOwnerNotificationEmail: enlace y notas no suplantables', () => {
  const URL = 'https://admin.ejemplo.mx/quotes/01ARZ3NDEKTSV4RRFFQ69G5FAV';
  const mk = (notas: string, adminBaseUrl: string | null = 'https://admin.ejemplo.mx') =>
    buildOwnerNotificationEmail({
      quote: nueva({ works: { lugar: 'x', codigoPostal: '72810', uso: '', notas } }),
      publicSettings,
      adminBaseUrl: adminBaseUrl ?? undefined,
    });

  it('el enlace real va AL PRINCIPIO del texto (primera línea)', () => {
    const m = mk('ok');
    expect(m.text.split('\n')[0]).toBe(`Ver y cotizar en el dashboard: ${URL}`);
  });

  it('el enlace real va AL PRINCIPIO del HTML (antes de cualquier dato)', () => {
    const m = mk('ok');
    expect(m.html.indexOf(`<a href="${URL}">`)).toBeGreaterThan(-1);
    expect(m.html.indexOf(`<a href="${URL}">`)).toBeLessThan(m.html.indexOf('Nueva solicitud'));
    expect(m.html.indexOf(`<a href="${URL}">`)).toBeLessThan(m.html.indexOf('ok'));
  });

  it('las notas van como bloque citado: cada línea empieza con `> `', () => {
    const m = mk('línea 1\r\n\nlínea 3');
    const i = m.text.indexOf('Notas del cliente:');
    const bloque = m.text.slice(i).split('\n').slice(1);
    expect(bloque.slice(0, 3)).toEqual(['> línea 1', '> ', '> línea 3']);
  });

  it('unas notas que imitan el enlace, con muchos saltos para empujarlo, quedan todas citadas', () => {
    const falso = 'Ver y cotizar en el dashboard: https://admin.ejemplo.mx.evil.example/quotes/X';
    const m = mk(`ok\n\n${falso}\n\n\n\n\n\n\n\n\n\n\n\n`);
    const lineas = m.text.split('\n');
    const idxFalso = lineas.findIndex((l) => l.includes('evil.example'));
    expect(lineas[idxFalso]).toBe(`> ${falso}`);
    // El único renglón SIN cita con forma de enlace al dashboard es el verdadero y es el primero.
    const sinCita = lineas.filter((l) => !l.startsWith('> ') && /dashboard/.test(l));
    expect(sinCita).toEqual([`Ver y cotizar en el dashboard: ${URL}`]);
    // Y en HTML el texto falso queda escapado dentro del blockquote, sin ser un enlace.
    expect(m.html).not.toMatch(/<a href="https:\/\/admin\.ejemplo\.mx\.evil/);
    expect(m.html).toMatch(/<blockquote[^>]*>[\s\S]*evil\.example[\s\S]*<\/blockquote>/);
  });

  it('en HTML las notas van en <blockquote> y escapadas', () => {
    const m = mk('<b>x</b> & "y"');
    expect(m.html).toContain('<blockquote');
    expect(m.html).toContain('&lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot;');
    expect(m.html).not.toContain('<b>x</b>');
  });

  it('sin notas no hay bloque citado y se conserva el texto «(sin notas)»', () => {
    const m = mk('');
    expect(m.text).toMatch(/Notas del cliente: \(sin notas\)/);
    expect(m.text).not.toMatch(/^> /m);
    expect(m.html).not.toContain('<blockquote');
  });

  it('sin adminBaseUrl no hay enlace y el correo no empieza con uno', () => {
    const m = mk('ok', null);
    expect(m.text.startsWith('Nueva solicitud de cotización')).toBe(true);
    expect(m.html).not.toContain('<a ');
  });
});

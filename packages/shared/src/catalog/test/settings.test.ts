import { describe, expect, it } from 'vitest';
import {
  MAIL_TEMPLATE_VARIABLES,
  mailSettingsSchema,
  publicSettingsSchema,
  renderMailTemplate,
  renderMailText,
  SETTINGS_ROW_KEYS,
} from '../settings';

// Datos de EJEMPLO (proyecto académico): los reales los da el dueño.
const publico = {
  nombrePatio: 'Patio de ejemplo',
  direccion: 'Calle de ejemplo 1, San Salvador el Seco, Puebla',
  lat: 19.1,
  lng: -97.6,
  horario: 'Lun a Sáb 9:00 a 18:00',
  whatsapp: '5212220000000',
  correoRemitente: 'ventas@ejemplo.test',
};

const correo = {
  asuntoCotizacion: 'Cotización {{folio}}',
  plantillaCotizacion:
    'Hola {{nombre}}, piedras: {{piedras}}. Flete: {{flete}}. Total: {{total}}. Vigencia: {{vigencia}}.',
};

describe('publicSettingsSchema', () => {
  it('parsea un ejemplo válido completo', () => {
    expect(publicSettingsSchema.parse(publico)).toEqual(publico);
  });

  it('falla si falta cualquier campo obligatorio', () => {
    for (const campo of Object.keys(publico)) {
      const resto = Object.fromEntries(Object.entries(publico).filter(([k]) => k !== campo));
      expect(publicSettingsSchema.safeParse(resto).success, campo).toBe(false);
    }
  });

  it('rechaza claves extra', () => {
    expect(publicSettingsSchema.safeParse({ ...publico, x: 1 }).success).toBe(false);
  });

  it('rechaza lat y lng fuera de rango o no finitas', () => {
    for (const lat of [-90.1, 90.1, Number.NaN]) {
      expect(publicSettingsSchema.safeParse({ ...publico, lat }).success, String(lat)).toBe(false);
    }
    for (const lng of [-180.1, 180.1, Number.POSITIVE_INFINITY]) {
      expect(publicSettingsSchema.safeParse({ ...publico, lng }).success, String(lng)).toBe(false);
    }
  });

  it('rechaza whatsapp con letras, "+", espacios o longitud incorrecta', () => {
    for (const whatsapp of [
      '52122200000a',
      '+5212220000000',
      '52 1222 000',
      '123456789',
      '12345678901234',
    ]) {
      expect(publicSettingsSchema.safeParse({ ...publico, whatsapp }).success, whatsapp).toBe(
        false,
      );
    }
  });

  it('rechaza correos inválidos', () => {
    for (const correoRemitente of ['no-es-correo', 'a@', '@b.com', '']) {
      expect(
        publicSettingsSchema.safeParse({ ...publico, correoRemitente }).success,
        correoRemitente,
      ).toBe(false);
    }
  });

  it('respeta los límites de longitud', () => {
    expect(
      publicSettingsSchema.safeParse({ ...publico, nombrePatio: 'x'.repeat(121) }).success,
    ).toBe(false);
    expect(publicSettingsSchema.safeParse({ ...publico, horario: 'x'.repeat(201) }).success).toBe(
      false,
    );
  });
});

describe('mailSettingsSchema', () => {
  it('parsea un ejemplo válido completo', () => {
    expect(mailSettingsSchema.parse(correo)).toEqual(correo);
  });

  it('expone las 6 variables permitidas', () => {
    expect([...MAIL_TEMPLATE_VARIABLES]).toEqual([
      'nombre',
      'folio',
      'piedras',
      'flete',
      'total',
      'vigencia',
    ]);
  });

  it('falla si falta cualquier campo y rechaza claves extra', () => {
    expect(mailSettingsSchema.safeParse({ asuntoCotizacion: 'x' }).success).toBe(false);
    expect(mailSettingsSchema.safeParse({ plantillaCotizacion: 'x' }).success).toBe(false);
    expect(mailSettingsSchema.safeParse({ ...correo, x: 1 }).success).toBe(false);
  });

  it('rechaza variables desconocidas', () => {
    expect(
      mailSettingsSchema.safeParse({ ...correo, plantillaCotizacion: 'Hola {{apellido}}' }).success,
    ).toBe(false);
    expect(mailSettingsSchema.safeParse({ ...correo, asuntoCotizacion: '{{otra}}' }).success).toBe(
      false,
    );
  });

  it('rechaza llaves mal formadas', () => {
    for (const t of [
      '{{ }}',
      '{{nombre',
      'nombre}}',
      '{{}}',
      '{{ nombre }}',
      '{nombre}}',
      '{{nombre}',
      '{{{nombre}}}',
    ]) {
      expect(mailSettingsSchema.safeParse({ ...correo, plantillaCotizacion: t }).success, t).toBe(
        false,
      );
    }
  });

  it('respeta los límites de longitud', () => {
    expect(
      mailSettingsSchema.safeParse({ ...correo, plantillaCotizacion: 'x'.repeat(8001) }).success,
    ).toBe(false);
    expect(
      mailSettingsSchema.safeParse({ ...correo, asuntoCotizacion: 'x'.repeat(201) }).success,
    ).toBe(false);
  });
});

describe('renderMailTemplate', () => {
  const valores = {
    nombre: 'Ana',
    folio: 'CN-2026-00001',
    piedras: 'Arenisca',
    flete: '$1,000',
    total: '$5,000',
    vigencia: '15 días',
  };

  it('sustituye todas las variables', () => {
    expect(renderMailTemplate('{{nombre}} {{folio}} / {{vigencia}}', valores)).toBe(
      'Ana CN-2026-00001 / 15 días',
    );
  });

  it('escapa HTML de los valores', () => {
    const out = renderMailTemplate('Hola {{nombre}}', {
      ...valores,
      nombre: `<script>alert("x")</script> & 'o'`,
    });
    expect(out).toBe('Hola &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;o&#39;');
    expect(out).not.toContain('<script>');
  });

  it('no vuelve a interpretar variables dentro de los valores', () => {
    expect(renderMailTemplate('{{nombre}}', { ...valores, nombre: '{{folio}}' })).toBe('{{folio}}');
  });

  it('lanza error explícito si falta una variable', () => {
    const incompletos = Object.fromEntries(Object.entries(valores).filter(([k]) => k !== 'total'));
    expect(() => renderMailTemplate('Total {{total}}', incompletos as never)).toThrow(/total/);
  });

  it('lanza error si la plantilla usa una variable no permitida', () => {
    expect(() => renderMailTemplate('{{otra}}', valores)).toThrow(/otra/);
  });
});

describe('SETTINGS_ROW_KEYS', () => {
  it('son las claves de fila que usa el seed: PUBLIC y MAIL', () => {
    expect(SETTINGS_ROW_KEYS).toEqual({ public: 'PUBLIC', mail: 'MAIL' });
  });
});

describe('renderMailText (sin escape: asunto y texto plano)', () => {
  const valores = {
    nombre: 'Ana & <Luis>',
    folio: 'CN-1',
    piedras: 'x',
    flete: 'y',
    total: 'z',
    vigencia: 'v',
  };
  it('NO escapa HTML (saldría «&amp;» en un asunto o texto plano)', () => {
    expect(renderMailText('Hola {{nombre}}', valores)).toBe('Hola Ana & <Luis>');
  });
  it('una sola pasada: el valor nunca se reinterpreta como plantilla', () => {
    expect(renderMailText('{{nombre}}', { ...valores, nombre: '{{folio}}' })).toBe('{{folio}}');
  });
  it('rechaza variables desconocidas y valores faltantes', () => {
    expect(() => renderMailText('{{secreto}}', valores)).toThrow(/no permitida/);
    expect(() => renderMailText('{{nombre}}', { folio: 'x' } as never)).toThrow(/Falta el valor/);
  });
});

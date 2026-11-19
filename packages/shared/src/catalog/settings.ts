import { z } from 'zod';
import { text } from './common';

// Valores de la clave de partición (`key`) de las dos filas únicas de la tabla Settings.
// El seed y la API de administración deben usar los mismos.
export const SETTINGS_ROW_KEYS = { public: 'PUBLIC', mail: 'MAIL' } as const;

// Fila PUBLIC de Settings (CLAUDE.md 5.5 y 6.2).
// Los valores reales (patio, WhatsApp, correo) los da el dueño; los del seed son DE EJEMPLO.
export const publicSettingsSchema = z.strictObject({
  nombrePatio: text(120, 'El nombre del patio'),
  direccion: text(300, 'La dirección'),
  lat: z
    .number({ error: 'La latitud debe ser un número' })
    .finite('La latitud debe ser un número finito')
    .min(-90, 'La latitud mínima es -90')
    .max(90, 'La latitud máxima es 90'),
  lng: z
    .number({ error: 'La longitud debe ser un número' })
    .finite('La longitud debe ser un número finito')
    .min(-180, 'La longitud mínima es -180')
    .max(180, 'La longitud máxima es 180'),
  horario: text(200, 'El horario'),
  // Solo dígitos, con lada de país y sin "+" (formato de wa.me). Dato de ejemplo.
  whatsapp: z
    .string({ error: 'El WhatsApp debe ser texto' })
    .regex(/^\d{10,13}$/, 'El WhatsApp debe tener de 10 a 13 dígitos, sin "+" ni espacios'),
  correoRemitente: z
    .string({ error: 'El correo debe ser texto' })
    .max(254, 'El correo admite máximo 254 caracteres')
    .email('El correo remitente no es válido'),
});
export type PublicSettings = z.infer<typeof publicSettingsSchema>;

// Variables permitidas en las plantillas de correo (CLAUDE.md 5.5), con sintaxis {{variable}}.
export const MAIL_TEMPLATE_VARIABLES = [
  'nombre',
  'folio',
  'piedras',
  'flete',
  'total',
  'vigencia',
] as const;
export type MailTemplateVariable = (typeof MAIL_TEMPLATE_VARIABLES)[number];

const TOKEN = /\{\{([^{}]*)\}\}/g;

function isAllowedVariable(name: string): name is MailTemplateVariable {
  return (MAIL_TEMPLATE_VARIABLES as readonly string[]).includes(name);
}

/** Valida que solo haya tokens `{{variable}}` permitidos y ninguna llave suelta. */
function templateField(max: number, label: string) {
  return text(max, label).superRefine((value, ctx) => {
    for (const match of value.matchAll(TOKEN)) {
      const name = match[1] ?? '';
      if (!isAllowedVariable(name)) {
        ctx.addIssue({
          code: 'custom',
          message: `${label}: la variable "{{${name}}}" no está permitida (usa: ${MAIL_TEMPLATE_VARIABLES.join(', ')})`,
        });
      }
    }
    // Lo que quede tras quitar los tokens bien formados no debe tener llaves.
    if (/[{}]/.test(value.replace(TOKEN, ''))) {
      ctx.addIssue({
        code: 'custom',
        message: `${label}: hay llaves mal formadas; usa la sintaxis {{variable}}`,
      });
    }
  });
}

// Fila MAIL de Settings.
export const mailSettingsSchema = z.strictObject({
  plantillaCotizacion: templateField(8000, 'La plantilla'),
  asuntoCotizacion: templateField(200, 'El asunto'),
});
export type MailSettings = z.infer<typeof mailSettingsSchema>;

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/**
 * Sustituye `{{variable}}` por su valor con el HTML escapado (evita inyección en el correo).
 * Una sola pasada: el contenido de los valores nunca se reinterpreta como plantilla.
 * Lanza error si la variable no está permitida o no se proporcionó.
 */
export function renderMailTemplate(
  plantilla: string,
  valores: Readonly<Record<MailTemplateVariable, string>>,
): string {
  return plantilla.replace(TOKEN, (_token, name: string) => {
    if (!isAllowedVariable(name)) {
      throw new Error(`Variable de plantilla no permitida: "${name}"`);
    }
    const value = Object.hasOwn(valores, name) ? valores[name] : undefined;
    if (typeof value !== 'string') {
      throw new Error(`Falta el valor de la variable de plantilla: "${name}"`);
    }
    return escapeHtml(value);
  });
}

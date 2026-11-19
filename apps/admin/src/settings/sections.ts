import type { FieldDef } from '../components/EntityForm';
import type { Draft } from '../lib/draft';

type Field = FieldDef<Draft>;

export const publicFields: readonly Field[] = [
  { name: 'nombrePatio', label: 'Nombre del patio', kind: 'text' },
  { name: 'direccion', label: 'Dirección', kind: 'textarea', rows: 3 },
  { name: 'lat', label: 'Latitud', kind: 'number', hint: 'Entre -90 y 90. Ej. 19.0414.' },
  { name: 'lng', label: 'Longitud', kind: 'number', hint: 'Entre -180 y 180. Ej. -98.2063.' },
  { name: 'horario', label: 'Horario', kind: 'text' },
  {
    name: 'whatsapp',
    label: 'WhatsApp',
    kind: 'text',
    hint: 'Solo dígitos con lada de país, sin «+» ni espacios (10 a 13). Ej. 522221234567.',
  },
  { name: 'correoRemitente', label: 'Correo remitente', kind: 'text' },
];

export const mailFields: readonly Field[] = [
  { name: 'asuntoCotizacion', label: 'Asunto del correo de cotización', kind: 'text' },
  {
    name: 'plantillaCotizacion',
    label: 'Plantilla del correo de cotización',
    kind: 'textarea',
    rows: 12,
    hint: 'Usa variables con la sintaxis {{variable}}; abajo están las permitidas.',
  },
];

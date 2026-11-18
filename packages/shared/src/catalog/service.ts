import { z } from 'zod';
import { idSchema, text, textOrEmpty } from './common';

// Servicio (CLAUDE.md 6.1): id, titulo, descripcion.
export const serviceSchema = z.strictObject({
  id: idSchema,
  titulo: text(120, 'El título'),
  descripcion: textOrEmpty(4000, 'La descripción'),
  activa: z.boolean({ error: 'activa debe ser verdadero o falso' }),
});
export type Service = z.infer<typeof serviceSchema>;

import { z } from 'zod';
import { idSchema, photoKeySchema, text, textOrEmpty } from './common';

// Acabado (CLAUDE.md 6.1): id, nombre, descripcion, foto.
export const finishSchema = z.strictObject({
  id: idSchema,
  nombre: text(120, 'El nombre'),
  descripcion: textOrEmpty(4000, 'La descripción'),
  foto: photoKeySchema('finishes').nullable(),
  activa: z.boolean({ error: 'activa debe ser verdadero o falso' }),
});
export type Finish = z.infer<typeof finishSchema>;

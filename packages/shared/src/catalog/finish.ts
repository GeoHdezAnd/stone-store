import { z } from 'zod';
import { addPhotoOwnershipIssues, idSchema, photoKeySchema, text, textOrEmpty } from './common';

// Acabado (CLAUDE.md 6.1): id, nombre, descripcion, foto.
export const finishSchema = z
  .strictObject({
    id: idSchema,
    nombre: text(120, 'El nombre'),
    descripcion: textOrEmpty(4000, 'La descripción'),
    foto: photoKeySchema('finishes').nullable(),
    activa: z.boolean({ error: 'activa debe ser verdadero o falso' }),
  })
  .superRefine((finish, ctx) => {
    if (finish.foto !== null) {
      addPhotoOwnershipIssues(ctx, 'finishes', finish.id, [finish.foto], ['foto'], true);
    }
  });
export type Finish = z.infer<typeof finishSchema>;

import { S3Client } from '@aws-sdk/client-s3';
import { createVariantsHandler } from './process-event';
import { S3ObjectStore } from './s3-store';
import { SharpImageProcessor } from './sharp-processor';

/*
 * Lambda de variantes de imagen (CLAUDE.md 6.3, fase 6.3).
 * - Notificaciones de S3 -> Lambda: el bucket avisa a esta función cada vez que se crea un objeto
 *   (evento `ObjectCreated`); es invocación ASÍNCRONA, sin servidor intermedio ni polling. El
 *   servicio de notificaciones es gratis: solo se paga la invocación de Lambda (~USD 0.20 por millón
 *   más el tiempo de cómputo) y las lecturas/escrituras de S3 (centavos con este volumen).
 * - sharp/libvips: ver `sharp-processor.ts`.
 */

// Se lee el entorno y se crean los clientes UNA vez, al arrancar (se reutilizan entre invocaciones).
const bucket = process.env['MEDIA_BUCKET'];
if (bucket === undefined || bucket === '') {
  throw new Error('Falta la variable de entorno MEDIA_BUCKET.');
}

export const handler = createVariantsHandler({
  bucket,
  store: new S3ObjectStore(new S3Client({})),
  processor: new SharpImageProcessor(),
});

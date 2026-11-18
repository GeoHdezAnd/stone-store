import { createMediaRouter } from './routes';
import { createPresigner, createS3Client } from './presigner';

// Se lee el entorno y se crea el cliente UNA vez, al arrancar (se reutiliza entre invocaciones).
const bucket = process.env['MEDIA_BUCKET'];
if (bucket === undefined || bucket === '') {
  throw new Error('Falta la variable de entorno MEDIA_BUCKET.');
}

// `S3_PUBLIC_ENDPOINT` solo existe con emulador: firma con el endpoint que alcanza el navegador.
const client = createS3Client({ S3_PUBLIC_ENDPOINT: process.env['S3_PUBLIC_ENDPOINT'] });

export const handler = createMediaRouter({ bucket, presign: createPresigner(client) }).handle;

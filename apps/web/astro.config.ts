import { defineConfig } from 'astro/config';

// Sitio público: HTML estático (CLAUDE.md 4). Sin adaptador ni SSR; el resultado va a S3 + CloudFront.
export default defineConfig({
  // URL pública para canonical, Open Graph y sitemap. El valor por defecto es un dominio de
  // EJEMPLO (`.example` no resuelve); en producción se define PUBLIC_SITE_URL.
  site: process.env['PUBLIC_SITE_URL'] ?? 'https://canteras-naturales.example',
  output: 'static',
  // Las URLs terminan en «/» (`/catalog/`): coincide con `build.format: 'directory'` y con S3.
  trailingSlash: 'always',
  devToolbar: { enabled: false },
  // Solo en desarrollo: Floci responde el preflight CORS con 401, así que el navegador llama a
  // `/_aws/...` en este servidor y Vite lo reenvía a Floci (igual que en `apps/admin`).
  vite: {
    server: {
      proxy: {
        '/_aws': { target: 'http://localhost:4566', changeOrigin: true },
        // Solo en desarrollo y solo si defines MEDIA_DEV_BUCKET: sirve las fotos del bucket de media
        // de Floci en `/media/...` (en AWS real las sirve CloudFront con `PUBLIC_MEDIA_BASE_URL`).
        ...(process.env['MEDIA_DEV_BUCKET']
          ? {
              '/media': {
                target: 'http://localhost:4566',
                changeOrigin: true,
                rewrite: (p: string) =>
                  `/${process.env['MEDIA_DEV_BUCKET']}${p.slice('/media'.length)}`,
              },
            }
          : {}),
      },
    },
  },
});

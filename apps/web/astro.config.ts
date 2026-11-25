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
      proxy: { '/_aws': { target: 'http://localhost:4566', changeOrigin: true } },
    },
  },
});

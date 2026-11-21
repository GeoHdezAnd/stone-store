import { defineConfig } from 'astro/config';

// Sitio público: HTML estático (CLAUDE.md 4). Sin adaptador ni SSR; el resultado va a S3 + CloudFront.
export default defineConfig({
  output: 'static',
  // Las URLs terminan en «/» (`/catalog/`): coincide con `build.format: 'directory'` y con S3.
  trailingSlash: 'always',
  devToolbar: { enabled: false },
});

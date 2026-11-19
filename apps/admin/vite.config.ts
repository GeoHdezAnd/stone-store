import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// En desarrollo, Floci no responde bien el CORS: en Cognito no responde nada y en la API
// contesta el preflight (OPTIONS) con 401 porque le aplica el authorizer, y el navegador exige 2xx.
// El navegador llama a `/cognito/` y `/_aws/` en el mismo origen (sin preflight) y Vite reenvía
// la petición a Floci (solo `vite dev`).
const FLOCI = 'http://localhost:4566';

export default defineConfig({
  plugins: [react()],
  // amazon-cognito-identity-js espera `global` (API de Node) en el navegador.
  define: { global: 'globalThis' },
  optimizeDeps: { esbuildOptions: { define: { global: 'globalThis' } } },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/_aws': { target: FLOCI, changeOrigin: true },
      '/cognito': {
        target: FLOCI,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/cognito/, ''),
      },
    },
  },
  build: { sourcemap: false },
});

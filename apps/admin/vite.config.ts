import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// En desarrollo, Floci no responde CORS en el endpoint de Cognito. El navegador llama a
// `/cognito/` en el mismo origen y Vite reenvía la petición a Floci (solo `vite dev`).
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
      '/cognito': {
        target: FLOCI,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/cognito/, ''),
      },
    },
  },
  build: { sourcemap: false },
});

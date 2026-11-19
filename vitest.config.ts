import { defineConfig } from 'vitest/config';

// Las apps de frontend (apps/*) NO llevan tests por decisión del dueño (ver CLAUDE.md, sección 10).
export default defineConfig({
  test: {
    projects: ['packages/*', 'services/*', 'infra', 'scripts'].map((p) => ({
      extends: false,
      test: {
        name: p,
        include: [`${p}/**/*.test.{ts,tsx}`],
        exclude: ['**/node_modules/**', '**/dist/**'],
      },
    })),
  },
});

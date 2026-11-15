import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*', 'services/*', 'infra', 'apps/*', 'scripts'].map((p) => ({
      extends: false,
      test: {
        name: p,
        include: [`${p}/**/*.test.{ts,tsx}`],
        exclude: ['**/node_modules/**', '**/dist/**'],
      },
    })),
  },
});

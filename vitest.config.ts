import { defineConfig } from 'vitest/config';

// One run for the whole monorepo: `npm test` from the root.
export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    environment: 'node',
  },
});

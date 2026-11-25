import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    watch: false,
    passWithNoTests: true,
    testTimeout: 30000,
    hookTimeout: 120000,
    pool: 'forks',
    include: ['packages/*/tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/build/**', '**/node_modules/**', '**/tests/**', '**/*.d.ts'],
    },
  },
  resolve: {
    // the packages' sources, so that the tests need no build
    alias: [{ find: /^@ayni\.org\/ayni-(.*)$/, replacement: `${import.meta.dirname}/packages/$1/src` }],
  },
})

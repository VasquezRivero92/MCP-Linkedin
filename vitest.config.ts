import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      exclude: [
        'node_modules/',
        'dist/',
        '**/*.test.ts',
        '**/*.config.ts',
        '**/*.config.js',
        '**/types.ts',
        'src/index.ts', // Entry point, tested manually
      ],
      thresholds: {
        lines: 55,
        functions: 70,
        branches: 38,
        statements: 55,
      },
    },
  },
});


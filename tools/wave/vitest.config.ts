import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'wave-engine',
    watch: false,
    globals: true,
    passWithNoTests: false,
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    reporters: ['default'],
  },
});

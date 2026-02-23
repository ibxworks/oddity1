import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/**/__tests__/*.test.ts', 'api/**/__tests__/*.test.ts'],
    globals: true,
  },
});

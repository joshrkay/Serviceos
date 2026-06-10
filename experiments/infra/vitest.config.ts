import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globals: true,
  },
  ssr: {
    noExternal: ['aws-cdk-lib', 'constructs'],
  },
});

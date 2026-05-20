import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
  ssr: {
    noExternal: ['aws-cdk-lib', 'constructs'],
  },
});

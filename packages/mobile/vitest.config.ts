import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Pure-logic tests (design tokens, formatters, hooks that don't render RN)
// run under Vitest — the repo's standard test tool — so they need no Expo/RN
// toolchain. React Native component-render tests use jest-expo (`test:rn`).
export default defineConfig({
  esbuild: {
    // Don't read packages/mobile/tsconfig.json here — it `extends`
    // expo/tsconfig.base, which only exists after `npm install` in this
    // isolated project. Pure-logic tests don't need the Expo TS settings.
    tsconfigRaw: '{}',
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // tsconfigRaw above disables esbuild's tsconfig path resolution, so map the
    // project aliases explicitly here for tests that import via them. Shared
    // points at its built `dist` (matches metro.config.js / tsconfig.json).
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@ai-service-os/shared': path.resolve(__dirname, '../shared/dist/index.js'),
    },
  },
});

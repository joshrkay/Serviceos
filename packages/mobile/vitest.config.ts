import { defineConfig } from 'vitest/config';

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
  },
});

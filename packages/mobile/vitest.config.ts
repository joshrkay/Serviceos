import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Pure-logic tests (design tokens, formatters, pipelines) and hook tests run
// under Vitest — the repo's standard test tool — so they need no Expo/RN
// toolchain. Hook tests render via @testing-library/react under jsdom (per-file
// `// @vitest-environment jsdom`) with the native modules mocked. React Native
// component-render tests use jest-expo (`test:rn`).
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
    // project aliases explicitly here for tests that import via them. Shared is
    // resolved from source (matches metro.config.js / tsconfig.json). Current
    // tests only type-import shared (erased at runtime); a future value import
    // would need a .js→.ts resolver here too.
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@ai-service-os/shared': path.resolve(__dirname, '../shared/src/index.ts'),
      // Pin a single React copy — the repo-root one, which is always installed
      // (packages/mobile is not a workspace, so its node_modules is absent in
      // the root-hoisted CI lane). The hook test renders via
      // @testing-library/react (a root devDep); without this the hook would
      // resolve React from packages/mobile/node_modules locally and collide
      // with the renderer's root React ("invalid hook call").
      react: path.resolve(__dirname, '../../node_modules/react'),
      'react-dom': path.resolve(__dirname, '../../node_modules/react-dom'),
      // expo-audio / expo-file-system have react-native-only package entries
      // that don't resolve under the jsdom env the hook test uses. They are
      // mocked per test, so alias them to resolve-time stubs.
      'expo-audio': path.resolve(__dirname, './test/stubs/expo-audio.ts'),
      'expo-file-system': path.resolve(__dirname, './test/stubs/expo-file-system.ts'),
      '@clerk/clerk-expo': path.resolve(__dirname, './test/stubs/clerk-clerk-expo.ts'),
    },
  },
});

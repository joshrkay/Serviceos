import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Pure-logic tests (design tokens, formatters, pipelines) and hook tests run
// under Vitest — the repo's standard test tool — so they need no Expo/RN
// toolchain. Hook tests render via @testing-library/react under jsdom (per-file
// `// @vitest-environment jsdom`) with the native modules mocked. React Native
// component-render tests use jest-expo (`test:rn`).
export default defineConfig({
  // Vite 8 transforms TS/JSX with Oxc (not esbuild), so the old `esbuild`
  // block is ignored. Oxc has no `tsconfigRaw` bypass and always resolves the
  // nearest on-disk tsconfig — packages/mobile/tsconfig.json is kept
  // self-contained (no `expo/tsconfig.base` extends) precisely so this lane
  // resolves without installing the isolated Expo project. See that file's
  // top comment.
  oxc: {
    // Screen tests render .tsx with no explicit React import (the screens use
    // the automatic runtime via babel-preset-expo); use it here too so Oxc
    // emits react/jsx-runtime calls instead of bare React.createElement. This
    // overrides the tsconfig's `jsx: "react-native"` (which the real
    // `tsc --noEmit` typecheck still uses).
    jsx: { runtime: 'automatic' },
  },
  test: {
    // Tests live under src/ only — never under app/, where expo-router's
    // file-based routing would treat them as routes and Metro would bundle
    // vitest into the app. Screen tests under src/screens import from ../../app.
    include: ['src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      // Gate the testable surface: screens + logic. Exclude thin native
      // wrappers that only run on a device (no logic to assert), generated
      // tokens, the root layout (providers), test stubs, and tests themselves.
      include: ['src/**/*.ts', 'app/**/*.tsx'],
      exclude: [
        '**/*.test.ts',
        'src/voice/nativeVoiceDeps.ts',
        'src/push/nativePushDeps.ts',
        'src/push/nativeNotificationDeps.ts',
        'src/jobs/nativeJobPhotoDeps.ts',
        'src/location/nativeLocationDeps.ts',
        'src/lib/env.ts',
        'src/lib/tokenCache.ts',
        'src/calls/callbackStorage.ts',
        'src/theme/tokens.d.ts',
        'app/_layout.tsx',
        // Thin stub routes (no logic to assert).
        'app/(onboarding)/**',
        'app/(tabs)/_layout.tsx',
        'app/(tabs)/settings/_layout.tsx',
        'app/(tabs)/settings/brand-voice.tsx',
        'app/(tabs)/settings/voice.tsx',
        'app/jobs/\\[id\\]/photos.tsx',
      ],
      // Rescaled for vitest 4 (QUALITY-2026-07-12 WS8): @vitest/coverage-v8 v4
      // remaps via `ast-v8-to-istanbul` (no opt-out), counting statements/
      // functions more granularly than v1's `v8-to-istanbul`. The identical
      // 482 tests now measure stmts ~88% / funcs ~85% / lines ~91% / branches
      // ~76% (was stmts/lines ~96%, funcs ~93%) — a measurement change, not a
      // coverage regression (no test was removed or weakened). Floors sit a few
      // points under the new measured values; branches is unchanged (still
      // passes at ~76%).
      thresholds: { statements: 86, branches: 72, functions: 82, lines: 89 },
    },
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
      'expo-camera': path.resolve(__dirname, './test/stubs/expo-camera.ts'),
      'expo-file-system': path.resolve(__dirname, './test/stubs/expo-file-system.ts'),
      'expo-secure-store': path.resolve(__dirname, './test/stubs/expo-secure-store.ts'),
      '@clerk/clerk-expo': path.resolve(__dirname, './test/stubs/clerk-clerk-expo.ts'),
      // react-native + expo-router don't resolve under jsdom in the root-only
      // lane. Screen tests render against host-DOM stubs (and mock useRouter).
      'react-native': path.resolve(__dirname, './test/stubs/react-native.ts'),
      'expo-router': path.resolve(__dirname, './test/stubs/expo-router.ts'),
      // Native-only entry; the chrome components read insets, so stub to zero.
      'react-native-safe-area-context': path.resolve(
        __dirname,
        './test/stubs/react-native-safe-area-context.ts',
      ),
      // NetInfo's native entry doesn't resolve under jsdom/node in the
      // root-only lane; the connectivity layer drives state through
      // __emitNetInfoForTests, so this only needs to be importable.
      '@react-native-community/netinfo': path.resolve(
        __dirname,
        './test/stubs/react-native-community-netinfo.ts',
      ),
    },
  },
});

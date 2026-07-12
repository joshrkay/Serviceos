import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/test-setup.ts',
        'src/components/ui/**',     // shadcn/radix-ui library components
        'src/**/*.stories.tsx',      // Storybook story fixtures
        'src/main.tsx',              // app entry point
      ],
      thresholds: {
        // Rescaled for vitest 4 (QUALITY-2026-07-12 WS8): @vitest/coverage-v8
        // v4 remaps via `ast-v8-to-istanbul` (no opt-out), which counts
        // JSX/TSX statements and branches far more granularly than v1's
        // `v8-to-istanbul`. The identical 1,774 tests now measure ~70% lines /
        // ~60% branches instead of ~80% / ~75% — a measurement change, not a
        // coverage regression (no test was removed or weakened). Floors kept a
        // couple of points under the new measured values so an entirely
        // untested module still fails CI.
        lines: 68,
        branches: 57,
      },
    },
  },
});

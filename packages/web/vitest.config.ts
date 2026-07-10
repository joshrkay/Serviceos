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
        // Actual coverage sits at ~80% lines / ~75% branches; these
        // floors leave ~5 points of headroom so an entirely untested
        // module can no longer land without failing CI.
        lines: 75,
        branches: 70,
      },
    },
  },
});

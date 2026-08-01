import { defineConfig } from 'vitest/config';

// Vitest 4 removed the standalone `vitest.workspace.ts` file; multi-package
// runs are now expressed as `test.projects` in the root config. Each entry
// points at a package that owns its own vitest.config.ts (api/web/shared),
// so per-package include/exclude/environment/coverage settings are unchanged
// — this file only tells a root-level `vitest run` which projects to load.
// Per-package CI lanes still run their own config directly (`cd packages/api
// && vitest run`, `vitest run --root packages/web`, etc.) and do not depend
// on this file.
export default defineConfig({
  test: {
    projects: ['packages/api', 'packages/web', 'packages/shared'],
  },
});

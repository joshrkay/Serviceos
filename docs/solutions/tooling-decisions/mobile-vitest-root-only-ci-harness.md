---
title: "Testing the isolated mobile package under the root-only CI lane"
date: 2026-06-19
track: knowledge
problem_type: tooling-decisions
module: packages/mobile
tags: ["mobile", "vitest", "testing-library", "expo", "jsdom", "ci", "react-native", "nativewind"]
related: []
---

## Context

`packages/mobile` is an **isolated project** — deliberately NOT a root npm
workspace — so the Railway api/web Docker build never pulls in Expo/React
Native. The trade-off: the PR-checks "Mobile unit tests" step runs
`npx vitest run --root packages/mobile` after only the **root** `npm ci`, so
`packages/mobile/node_modules` is **absent in CI**. Any test that needs a
dependency living only in the mobile package fails the required check.

This is the harness that lets RN **screens** and **hooks** be tested in that
root-only lane — no Expo install, no `jest-expo` — while staying green both
locally (mobile deps present) and in CI (only root deps present).

## Guidance

Render with tooling the **repo root already has** as devDeps:
`@testing-library/react` + `jsdom` + `react`/`react-dom`. In
`packages/mobile/vitest.config.ts`:

- `esbuild.jsx: 'automatic'` — the screens use the automatic runtime (no
  explicit `React` import); without this esbuild emits bare
  `React.createElement` and screens fail with "React is not defined".
- **Pin React to the root copy** so the renderer and the hook/screen share one
  instance (locally they'd otherwise resolve different React copies → "invalid
  hook call"; in CI only the root copy exists, so the alias is a no-op there).
- **Resolve-time stubs** for native modules that have no jsdom-resolvable entry
  (`react-native`, `expo-audio`, `expo-file-system`, `expo-router`,
  `@clerk/clerk-expo`). They're mocked per test via `vi.mock`; the stubs only
  need to *resolve*. The `react-native` stub maps host components to DOM
  elements so `className` (NativeWind) tap-target assertions work.

```ts
// vitest.config.ts — alias block
react: path.resolve(__dirname, '../../node_modules/react'),
'react-dom': path.resolve(__dirname, '../../node_modules/react-dom'),
'react-native': path.resolve(__dirname, './test/stubs/react-native.ts'),
'expo-router': path.resolve(__dirname, './test/stubs/expo-router.ts'),
'expo-audio': path.resolve(__dirname, './test/stubs/expo-audio.ts'),
'expo-file-system': path.resolve(__dirname, './test/stubs/expo-file-system.ts'),
'@clerk/clerk-expo': path.resolve(__dirname, './test/stubs/clerk-clerk-expo.ts'),
```

- **Each mocked module needs its OWN stub file.** Aliasing two modules
  (e.g. `expo-audio` and `expo-file-system`) to the *same* file gives them one
  module id, so the second `vi.mock` silently overwrites the first.
- **Screen tests must live under `src/`, never under `app/`.** expo-router's
  file-based routing treats every file in `app/` as a route, so a
  `app/foo.test.ts` gets bundled by Metro → it imports `vitest` → `expo export`
  fails (`Unable to resolve @vitest/runner/utils`). Put screen tests in
  `src/screens/*.test.ts` importing `../../app/<screen>`.
- Each test file that renders needs `// @vitest-environment jsdom` at the top.
- Gate it: run the CI step with `--coverage` and set thresholds in
  `vitest.config.ts` so dropped tests / untested new code fail the lane.

Sample screen test (host-DOM stub lets you assert the ≥44px tap-target rule):

```ts
// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { createElement } from 'react';
vi.mock('../hooks/useMe', () => ({ useMe: () => ({ me: h.me, /* … */ }) }));
import Home from '../../app/index';

const { container } = render(createElement(Home));
for (const b of container.querySelectorAll('button')) {
  expect(b.className).toMatch(/\bmin-h-11\b/); // CLAUDE.md tap-target contract
}
```

## Why This Matters

It keeps the mobile CI lane **lightweight** (no Expo toolchain) while still
gating real screen/hook behavior + the tap-target contract — preserving the
isolation invariant that keeps RN out of the api/web image. Verified by
**deleting `packages/mobile/node_modules` and re-running** the suite
(simulating CI): all tests pass against root-only resolution. Make that
simulation part of verifying any change to the mobile test harness.

## When to Apply

Any time you add a test in `packages/mobile` that imports React, a screen, a
hook, or a native (`expo-*` / `react-native` / Clerk / expo-router) module —
i.e. anything beyond pure RN-free logic.

## What Didn't Work (dead ends)

- **`react-test-renderer`** — renders in node (no DOM) and the screen test
  passed locally, but it isn't a root devDep, so CI failed
  (`Failed to load url react-test-renderer`). Switched to
  `@testing-library/react` + jsdom (both root devDeps).
- **jsdom + real expo packages** — under jsdom, Vite can't resolve
  `expo-audio`/`expo-file-system` (react-native-only package entries). Fixed
  with resolve-time stub aliases (the modules are `vi.mock`'d anyway).
- **One shared stub for several modules** — `vi.mock` collisions (see above).
- **Colocating tests in `app/`** — expo-router routed them and `expo export`
  broke. Moved to `src/screens/`.
- **Forgetting the React pin** — `@testing-library/react` (root React) +
  hook (mobile React) → "invalid hook call" locally.

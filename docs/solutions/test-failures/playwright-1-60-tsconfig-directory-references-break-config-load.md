---
title: "Playwright ≥1.60 tsconfig loader breaks on directory-style project references"
date: 2026-08-01
track: bug
problem_type: test-failures
module: tsconfig.json / e2e
tags: ["playwright", "tsconfig", "project-references", "ci", "e2e"]
related: []
---

## Problem
After the dependabot bump to `@playwright/test` 1.62 (PR #757), the `playwright` CI check died at config load — before collecting a single spec — on both main and every PR.

## Symptoms
Playwright throws during startup resolving the root `tsconfig.json`; no tests run. The error names a nonexistent `packages/<name>.json`. Local runs may still pass if `node_modules` predates the bump (the "local green" illusion — run `npm ci` before trusting local).

## What Didn't Work
Chasing the E2E specs themselves — no spec ever executed. The failure is in Playwright's bundled tsconfig loader (`resolveConfigFile` in `packages/playwright/src/transform/tsconfig-loader.ts`, added ≥1.60): it appends `.json` to any project-reference path, so a directory-style reference `{ "path": "./packages/shared" }` resolves to `packages/shared.json` instead of `packages/shared/tsconfig.json`.

## Solution
Point root tsconfig references at explicit files — byte-identical semantics for tsc:

```jsonc
// before
{ "path": "./packages/shared" }
// after
{ "path": "./packages/shared/tsconfig.json" }
```

Fixed in commit `237fda15` (PR #791).

## Why This Works
tsc accepts both directory and file forms; Playwright's loader only handles the file form. Explicit files satisfy both.

## Prevention
Keep root tsconfig project references in explicit-file form. Cheap detection: `npx playwright test --list` in CI (or locally after any tsconfig/reference change) fails fast at config load without running specs.

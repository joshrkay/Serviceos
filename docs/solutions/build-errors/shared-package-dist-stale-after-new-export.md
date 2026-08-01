---
title: "Adding a shared export: rebuild packages/shared/dist or web sees 'is not a function'"
date: 2026-06-24
track: bug
problem_type: build-errors
module: packages/shared, packages/web
tags: ["monorepo", "shared", "dist", "build", "module-resolution", "vitest", "tsc"]
related: ["docs/solutions/architecture-patterns/derive-shared-status-rule-across-frontends.md"]
---

## Problem

Added a new export to `packages/shared` (a new file + an `export *` in
`src/index.ts`), imported it from `packages/web`, and the web tests blew up with
the symbol being `undefined` — even though the shared code and its own test were
correct.

## Symptoms

```
TypeError: isInvoiceOverdue is not a function
 ❯ Module.deriveInvoiceUiStatus src/utils/statusNormalize.ts:65
```

Telltale: the **shared** package's own test passes, **mobile** passes, but
**web** fails on the import. (Mobile's vitest resolves `@ai-service-os/shared`
to source; web resolves it to the built bundle, so they disagree.)

## What Didn't Work

- Re-running web tests / clearing vitest cache — the resolved module genuinely
  didn't contain the export.
- Assuming `@ai-service-os/shared` resolves to `src` everywhere — it doesn't for
  web.

## Solution

`packages/shared/package.json` has `"main": "./dist/index.js"` and no `exports`
override, so **web (and api) resolve `@ai-service-os/shared` to the built
`dist/`, not `src/`**. A brand-new source file isn't in `dist` until shared is
compiled. Rebuild it:

```bash
cd packages/shared && npm run build   # tsc → emits dist/contracts/<new>.js + updates dist/index.js
ls dist/contracts/ | grep <new-file>  # confirm it emitted
```

Then re-run the consumer's tests — the import resolves. (`dist/` is gitignored;
don't commit it. CI is unaffected because `npm install` runs shared's `prepare`
script, which builds `dist` on install — the staleness only bites mid-session
when you add a shared file after the last install/build.)

## Why This Works

The error is a stale-artifact problem, not a code problem: the consumer imports
the compiled bundle, and the bundle predates your new export. Recompiling shared
emits the new file and refreshes the barrel (`dist/index.js`), so the consumer's
module graph now contains the symbol.

## Prevention

- After editing anything under `packages/shared/src/`, run
  `cd packages/shared && npm run build` **before** running web/api tests.
- Don't trust a green **mobile** run as proof web will pass — mobile may resolve
  shared to source while web resolves to `dist`. Run the consumer whose
  resolution matches production (web → `dist`).
- If this recurs often, consider a `vitest`/`vite` alias mapping
  `@ai-service-os/shared` → `../shared/src` for web tests, or a watch build —
  but the one-line rebuild is usually enough.

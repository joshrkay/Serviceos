# Release check repair — CI run 34378723909

Two independent CI failures on `codex/stripe-release-checks` (branch is
clean off `origin/main` after PR #983 merged). No product behavior change;
this is env-contract + dependency-alignment repair only.

## Failure 1 — `npm run check:env-coverage` (pr-checks.yml)

Root cause: PR #983 (Stripe plan alignment) added `STRIPE_BASIC_PRICE_ID`
and `STRIPE_ENTERPRISE_PRICE_ID` to the zod config schema
(`packages/api/src/shared/config.ts:59-60`) and to
`packages/api/src/billing/subscription.ts`, but never declared them in
`.env.production.example`. `scripts/check-env-coverage.ts` treats the
template as the production contract; anything the API reads that is
neither declared there nor allowlisted fails the build.

Reproduced locally:
```
npx tsx scripts/check-env-coverage.ts
...
[env-coverage] FAIL: 2 env var(s) read by the API but neither declared nor allowlisted:
  - STRIPE_BASIC_PRICE_ID  (packages/api/src/shared/config.ts:59)
  - STRIPE_ENTERPRISE_PRICE_ID  (packages/api/src/shared/config.ts:60)
```

Fix: add both as active (uncommented) `KEY=` lines under the existing
TIER 1 Stripe block in `.env.production.example`, next to
`STRIPE_PRICE_ID`. Per instruction, these are required production config
(each plan's checkout has no fallback price) — not allowlisted as
optional. The deprecated `STRIPE_PRICE_ID` line stays as-is.

## Failure 2 — `npm ci` in `packages/mobile` (clean-install.yml, pr-checks.yml)

Root cause: `packages/mobile/package.json` pins several Expo native
modules and `react-native` above what Expo SDK52 actually bundles.
`expo-router@4.0.22` peer-depends on `expo-constants@~17.0.8`; the project
pins `~17.1.8`, so `npm ci` ERESOLVEs (confirmed locally, full peer chain
below). `react-native` is pinned to `0.87.1`, a version that does not
correspond to any SDK52 release (SDK52 bundles RN `0.76.9`) and several
other `expo-*` packages are similarly ahead of their SDK52-bundled range.

Reproduced locally (`npm ci` in `packages/mobile`):
```
npm error ERESOLVE could not resolve
npm error While resolving: expo-router@4.0.22
npm error Found: expo-constants@17.1.8 ... from the root project
npm error peer expo-constants@"~17.0.8" from expo-router@4.0.22
```

Authoritative source: `expo@52.0.49` (latest 52.x on npm)
`bundledNativeModules.json`, fetched from the registry/unpkg — this is
Expo's own compatibility table for SDK52, not a guess.

Packages pinned above their SDK52-bundled range (target versions from
`bundledNativeModules.json`, same range style — `~`/exact — as the
original entry):

| package | current | SDK52 bundled |
|---|---|---|
| react-native | 0.87.1 | 0.76.9 |
| expo-constants | ~17.1.8 | ~17.0.8 |
| expo-asset | ~11.1.7 | ~11.0.5 |
| expo-audio | ~0.4.9 | ~0.3.5 |
| expo-build-properties | ^0.14.8 | ~0.13.3 |
| expo-camera | ~16.1.11 | ~16.0.18 |
| expo-crypto | ~14.1.5 | ~14.0.2 |
| expo-file-system | ~18.1.11 | ~18.0.12 |
| expo-font | ~13.3.2 | ~13.0.4 |
| expo-linking | ~7.1.7 | ~7.0.5 |
| expo-location | ~18.1.6 | ~18.0.10 |
| expo-notifications | ^0.32.17 | ~0.29.14 |
| expo-secure-store | ~14.2.4 | ~14.0.1 |
| expo-status-bar | ~2.2.3 | ~2.0.1 |
| react-native-screens | ~4.27.0 | ~4.4.0 |
| react-native-web | ~0.21.2 | ~0.19.13 |

Already coherent with SDK52, left untouched: `expo` (`~52.0.0`),
`expo-router` (`~4.0.0`, satisfies bundled `~4.0.22`), `@expo/metro-runtime`
(`~4.0.1`), `react-native-gesture-handler` (`~2.20.2`),
`react-native-reanimated` (`~3.16.1`), `react-native-safe-area-context`
(`4.12.0`), `@react-native-community/netinfo` (`11.4.1`), `jest-expo`
(`~52.0.0`, satisfies bundled `~52.0.6`). Not in `bundledNativeModules.json`
(third-party, no SDK alignment applies) and left untouched:
`@clerk/clerk-expo`, `@expo-google-fonts/*`, `@stripe/stripe-terminal-react-native`,
`nativewind`, `zod`, and all devDependencies except the ones listed above.

Fix: edit only the rows in the table above in `packages/mobile/package.json`,
then regenerate `packages/mobile/package-lock.json` with a plain
`npm install` (no `--force`, no `--legacy-peer-deps`) so npm's own resolver
signs off on the peer graph, followed by a clean `npm ci` to prove the
lockfile is install-clean.

## Verification (in order)

1. `packages/mobile`: remove `node_modules`, `npm install` to regenerate
   the lockfile, then `npm ci` clean from the new lockfile.
2. `packages/mobile`: `npm run typecheck`.
3. `packages/api`: `npx tsc --project tsconfig.build.json --noEmit`
   (production build config per root `CLAUDE.md`).
4. Root: `npm run check:env-coverage`.

## Scope guard

No `--force`/`--legacy-peer-deps`, no broad SDK/major upgrades, no edits
outside `.env.production.example`, `packages/mobile/package.json`,
`packages/mobile/package-lock.json`, and this plan file. No commit/push/deploy.

## Independent coordinator verification

Codex reran the API production typecheck, mobile typecheck, and production env coverage guard: all passed. Expo compatibility check (`npx expo install --check`) reported dependencies up to date. Mobile Vitest: 116 files / 826 tests passed; expected error-boundary fixture errors appeared on stderr. Separate checkout/webhook/provisioning tests: 68 passed. Native iOS/Android builds were not run; this verifies dependency resolution, compatibility metadata and JavaScript tests, not a device release.

## Failure 3 — `npm run check:dependency-audit` (new CI failure after PR #984)

Root cause: `packages/api/package.json` pinned `sharp: "^0.35.1"`, which the
committed root `package-lock.json` resolved to exactly `0.35.1`. That
version is vulnerable to a bundled-libvips issue tracked as
`GHSA-rgj7-g3m4-5g8c` (wraps `GHSA-g89c-p67h-r497` and
`GHSA-2jg2-4ch7-h545`), fixed upstream in `sharp@0.35.4`. The project's
own blocking-severity gate (`docs/quality/dependency-audit-policy.md`,
run via `scripts/check-dependency-audit.ts`) flags this as `[high]` with
no exception on file, so the build fails rather than silently passing.

Reproduced locally:
```
npm run check:dependency-audit
...
BLOCKING:
  ✗ sharp [high] — no matching exception
      sharp: Vulnerabilities in libheif: GHSA-g89c-p67h-r497 and GHSA-2jg2-4ch7-h545
      https://github.com/advisories/GHSA-rgj7-g3m4-5g8c  (vulnerable: <0.35.4)
FAIL — 1 blocking, 1 excepted, 4 informational
```

Authoritative source: npm registry metadata for `sharp` —
`dist-tags.latest` = `0.35.4`, and `0.35.4` is the first release at or
above the advisory's fixed boundary (`versions` list confirms no
`0.35.2`/`0.35.3`/`0.35.4` release exists below the fix; `0.35.4` is the
patch that resolves the advisory).

Fix: bumped `packages/api/package.json` `sharp` from `^0.35.1` to
`^0.35.4` only (no other dependency touched), then regenerated the root
`package-lock.json` with `npm install --package-lock-only` so npm's own
resolver produces the lockfile (no manual edits to lock entries).

Limitation: regenerating the lockfile moved `sharp` (and its `@img/sharp-*`
platform/libvips optional dependencies) from being hoisted at the lockfile
root to nested under `packages/api/node_modules/sharp`, which npm's
resolver reports consistently across repeated `npm install
--package-lock-only` runs (with or without `-w packages/api` scoping) —
this is deterministic dedup output from the version bump, not an
artifact of how the command was invoked, but it does make the
`package-lock.json` diff far larger (~2,400 lines) than the single
version bump would suggest. No `package.json` outside
`packages/api/package.json` was edited, and no `--force` /
`--legacy-peer-deps` flags were used.

### Verification

1. `npm run check:dependency-audit` — PASS, 0 blocking (previously 1
   blocking on `sharp`), 1 pre-existing excepted (`react-router`, until
   2026-10-23), 4 pre-existing informational findings, all unchanged.
2. `packages/api`: `npx tsc --project tsconfig.build.json --noEmit` — no
   errors (production build config per root `CLAUDE.md`).
3. `packages/api`: `vitest run test/workers/image-post-process-worker.test.ts
   test/proposals/sms/reply-handler.test.ts` (the two suites touching
   sharp/image processing) — 2 files, 77 tests, all passed.

Not run: no code paths in `packages/api` call `sharp` with the specific
libheif-related APIs the advisory concerns, and this repair does not add
new usage — the fix is a version bump plus the existing test coverage
above, not new test coverage. No commit, push, or deploy was made; the
working tree changes are `packages/api/package.json`, root
`package-lock.json`, and this plan file only.

Coordinator review of the Sharp update: a clean root npm ci passed; resolving Sharp from the API confirmed installed version0.35.4. The original Sonnet image-test run used the old installed package, so the coordinator repeated the image tests against the patched library. Retained pre-existing libc metadata on14 unrelated optional platform packages that the local npm version had dropped; no unrelated dependency versions changed. Dependency audit passes with0 blocking findings under the existing policy (one pre-existing react-router exception remains).

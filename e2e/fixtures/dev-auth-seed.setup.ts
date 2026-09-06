import { test as setup } from '@playwright/test';

/**
 * Playwright "setup project" for `chromium-devauth` (playwright.config.ts).
 *
 * Named `*.setup.ts` (not `*.spec.ts`/`*.test.ts`) so it falls outside every
 * other project's default testMatch and never runs as a normal test.
 * `chromium-devauth` declares `dependencies: ['devauth-setup']`, which
 * guarantees this runs AFTER the dev-auth webServer pair (API +
 * VITE_AUTH_MODE=dev vite) is up and healthy — Playwright starts/awaits
 * `webServer` entries before any project's tests (setup projects included),
 * so an HTTP POST here can rely on the API actually being reachable, unlike
 * `e2e/global-setup.ts` (which runs BEFORE webServer starts and only sets up
 * env / hermetic Clerk tokens for that reason).
 *
 * Reuses packages/api/scripts/verify-seed.mjs's real seeding logic (a
 * customer, 3 jobs, 2 appointments, an estimate, a draft invoice — see that
 * file and packages/web/.claude/skills/verify/SKILL.md) rather than
 * duplicating the payload construction here.
 */
setup('seed representative data for dev-auth E2E specs', async () => {
  const apiURL = process.env.E2E_DEVAUTH_API_URL ?? 'http://127.0.0.1:3001';
  // verify-seed.mjs reads SEED_BASE/SEED_TOKEN once at module-evaluation
  // time, so set them before the dynamic import below (this module is only
  // ever imported once per Playwright run, from this one call site).
  process.env.SEED_BASE = apiURL;
  // verify-seed.mjs is a standalone JS script (no .d.ts — and this repo's
  // .gitignore excludes *.d.ts, so an ambient declaration file wouldn't ship)
  // — the plain dynamic import already works fine at runtime.
  // @ts-expect-error TS7016 — no type declarations for this plain-JS module
  const { seedVerifyData } = await import('../../packages/api/scripts/verify-seed.mjs');
  await seedVerifyData();
});

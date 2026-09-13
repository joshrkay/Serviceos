import { test as base, expect, type Page } from '@playwright/test';

/**
 * Dev-auth capability fixture (D-2 — see docs/verification, §7 P1-2).
 *
 * Many specs are gated on "is there a real, authenticated stack to test
 * against?" — historically that meant a real Clerk publishable key or an
 * authenticated E2E_BASE_URL, both of which are absent on a bare PR runner,
 * so 59 tests self-skipped on every run. This repo also ships a dev
 * test-auth mode (`VITE_AUTH_MODE=dev` + `DEV_AUTH_BYPASS=true`, see
 * packages/web/.claude/skills/verify/SKILL.md) that boots the whole
 * authenticated SPA with no Clerk cloud and no external deps — the
 * `chromium-devauth` Playwright project (playwright.config.ts) runs the
 * suite against that stack, seeded via
 * packages/api/scripts/verify-seed.mjs (e2e/fixtures/dev-auth-seed.setup.ts).
 *
 * `devAuthActive` is a **project-scoped fixture option**, not a bare
 * `process.env` flag, and that distinction matters: `npm run e2e` (no
 * `--project` filter) runs the legacy `chromium` project and
 * `chromium-devauth` in the SAME Node process, so a plain env var would leak
 * across both. The legacy `chromium` project boots the REAL Clerk SDK
 * (aliased away only under `VITE_AUTH_MODE=dev`) against whatever
 * VITE_CLERK_PUBLISHABLE_KEY it was given — on a bare runner that's a
 * syntactically-valid placeholder that Clerk's CDN will reject (no network
 * egress in CI/sandboxes), so treating dev-auth as "active" there would turn
 * clean skips into real failures instead of running the tests for real. The
 * fixture option is set via `use: { devAuthActive: true }` on
 * `chromium-devauth` only (playwright.config.ts) and defaults to false
 * everywhere else, so each project's tests see the right answer regardless
 * of how many projects share the run.
 */
export type DevAuthFixtures = {
  devAuthActive: boolean;
};

export const test = base.extend<DevAuthFixtures>({
  devAuthActive: [false, { option: true }],
});

export { expect };

/**
 * Skip the current test unless a runnable authenticated stack is present:
 * either the chromium-devauth project (devAuthActive) or the legacy gate
 * (a real Clerk key / authenticated E2E_BASE_URL, passed in as `legacyGate`
 * since the exact legacy condition differs slightly per spec — see
 * helpers/clerk-key.ts vs a bare `E2E_BASE_URL` check).
 *
 * Call from a `test.beforeEach` (fixture values are only available inside a
 * hook or test body, never at bare `test.describe` collection time).
 */
export function skipUnlessAuthedStack(devAuthActive: boolean, legacyGate: boolean, reason: string): void {
  test.skip(!devAuthActive && !legacyGate, reason);
}

/**
 * Dismiss the "What's new" modal (components/walkthrough/WhatsNewModal.tsx)
 * if it's open, then continue.
 *
 * packages/web/.claude/skills/verify/SKILL.md flags this as a runtime
 * gotcha: it's a pure-localStorage "have you seen the latest release" gate,
 * so under `chromium-devauth` — a fresh browser context (fresh localStorage)
 * against a fresh InMemory tenant on every single test — it opens on
 * literally every authenticated page's first render. Its backdrop is
 * `fixed inset-0` and intercepts pointer events, so any `.click()` made
 * without dismissing it first hangs until the actionTimeout. Call this right
 * after navigating to an authenticated route, before any interaction.
 * No-op (fast) if the modal isn't present — e.g. a persistent E2E_BASE_URL
 * environment that's already seen the current release.
 */
export async function dismissWhatsNewModal(page: Page): Promise<void> {
  const gotIt = page.getByRole('button', { name: 'Got it', exact: true });
  try {
    await gotIt.waitFor({ state: 'visible', timeout: 1_500 });
    await gotIt.click();
  } catch {
    // Never appeared — nothing to dismiss.
  }
}

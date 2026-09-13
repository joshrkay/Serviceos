import { test, expect } from '@playwright/test';
import { installClerkStub } from '../helpers/clerk-stub';
import { blockExternalHosts } from '../helpers/api-mocks/shell';
import { hasViteClerkKey } from '../helpers/clerk-key';
import { API_URL, bootstrapOwner } from '../fixtures/onboarding-hermetic-lane';

/**
 * 1.10 — "I want the AI to sound like my shop and then stop changing, so
 * my customers hear one voice." `brand-voice.integration.test.ts` +
 * `update-brand-voice-voice-execution.test.ts` already prove the write/lock
 * mechanics at real Postgres with T1 (rung 4). This spec is NOT that —
 * it's the rung-5 REACHABILITY investigation the ticket asked for: can a
 * real owner, through the real UI, reach the Brand-Voice Configurator at
 * all?
 *
 * Answer, reached and pinned here rather than assumed: NO. Two independent
 * checks against the real, current `main`:
 *
 *   1. `GET /api/me` resolves `brand_voice_configurator_enabled` through
 *      `isFlagEnabledForTenant(tenantId, 'brand_voice_configurator')`
 *      (packages/api/src/app.ts:5309) — tenant override -> platform flag
 *      -> false. No seed row exists anywhere for this flag, so it resolves
 *      false for every tenant, always.
 *   2. `packages/web/src/components/settings/SettingsPage.tsx:869/1588`
 *      renders the "Brand voice" Settings row/sheet ONLY when that flag is
 *      true — so the real Settings page (reachable by any owner past
 *      identity, per 1.5's soft gate) never shows it.
 *   3. `packages/api/src/routes/settings.ts:156`'s `OWNER_CAPABILITIES`
 *      list — the actual, real self-service flag-toggle mechanism this
 *      same codebase gives owners for OTHER per-tenant capabilities
 *      (`dropped_call_recovery`, `voice_vulnerability_triage`) —
 *      deliberately does NOT include `brand_voice_configurator`. Proven
 *      below by actually calling the real
 *      `PUT /api/settings/capabilities/brand_voice_configurator` route: it
 *      refuses with a 400 naming the allowed list, which does not include
 *      this flag.
 *
 * This matches the already-parked finding from the prior §8.1 lane run
 * (docs/audit/lane-reports/setup-8-1.md's "Not done — 1.10" section /
 * docs/audit/blocked-on-josh.md §1.10) — re-verified here against the
 * current tree rather than assumed stale. No onboarding-time toggle for
 * this flag exists either (grep for `brand_voice`/`BrandVoice` across
 * `OnboardingShell.tsx` and the onboarding step types returns nothing).
 * There is no SQL write, no admin route, and no env shortcut used here —
 * only real routes, reached as an owner actually can. 1.10 stays wherever
 * Fable already has it; this is not a rung claim.
 */

const REPORT_DIR = 'setup-8-1-r5';

test.describe('onboarding brand-voice configurator gate (1.10) — reachability ceiling, real Postgres', () => {
  const canRun =
    !process.env.E2E_BASE_URL &&
    hasViteClerkKey() &&
    process.env.E2E_USE_TEST_DB === 'true';
  test.skip(
    !canRun,
    'Requires the local webServer pair against a real Postgres: leave E2E_BASE_URL unset, ' +
      'set VITE_CLERK_PUBLISHABLE_KEY (placeholder ok), and E2E_USE_TEST_DB=true with DATABASE_URL ' +
      'pointing at the test container.',
  );

  test('a real owner past the soft gate never sees Brand voice in Settings, and the real self-service capability route explicitly refuses to toggle it', async ({
    page,
    baseURL,
  }) => {
    const owner = await bootstrapOwner(page, 'brandvoicegate');

    await page.request.put(`${API_URL}/api/onboarding/identity`, {
      headers: { 'content-type': 'application/json', ...owner.authHeaders },
      data: JSON.stringify({
        businessName: 'Brand Voice Gate HVAC',
        businessHours: { mon: { open: '08:00', close: '17:00' }, sat: null, sun: null },
        jobBufferMinutes: 30,
        hourlyRateCents: 15000,
        timezone: 'America/Chicago',
      }),
    });

    const meRes = await page.request.get(`${API_URL}/api/me`, { headers: owner.authHeaders });
    const me = (await meRes.json()) as { brand_voice_configurator_enabled?: boolean };
    expect(me.brand_voice_configurator_enabled, 'resolves false — no override anywhere seeds it on').toBe(
      false,
    );

    // ── Reachability: past identity, Settings is unlocked (1.5's soft
    //    gate) — this IS the real page a real owner lands on. ─────────────
    await installClerkStub(page, { signedIn: true, sub: owner.sub, token: owner.jwt });
    await blockExternalHosts(page, baseURL!);
    await page.goto('/settings');
    await expect(page).not.toHaveURL(/\/onboarding$/, { timeout: 15_000 });
    await expect(page.getByText(/brand voice/i)).toHaveCount(0);
    await page.screenshot({
      path: `docs/audit/lane-reports/${REPORT_DIR}/1.10-settings-no-brand-voice-row.png`,
      fullPage: true,
    });

    // ── The real self-service toggle route — proves there is no
    //    owner-facing way to flip this on, not merely that today's UI
    //    doesn't show a button for it. ───────────────────────────────────
    const toggleRes = await page.request.put(`${API_URL}/api/settings/capabilities/brand_voice_configurator`, {
      headers: { 'content-type': 'application/json', ...owner.authHeaders },
      data: JSON.stringify({ enabled: true }),
    });
    expect(toggleRes.status(), 'brand_voice_configurator is not an owner-settable capability').toBe(400);
    const toggleBody = (await toggleRes.json()) as { message?: string };
    expect(toggleBody.message).toMatch(/not an owner-settable capability/i);
    expect(toggleBody.message, 'the allowed list does not include this flag').not.toMatch(
      /brand_voice_configurator/,
    );

    // Confirm the refused PUT changed nothing.
    const meAfter = await page.request.get(`${API_URL}/api/me`, { headers: owner.authHeaders });
    const meAfterBody = (await meAfter.json()) as { brand_voice_configurator_enabled?: boolean };
    expect(meAfterBody.brand_voice_configurator_enabled).toBe(false);
  });
});

import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { installClerkStub } from '../helpers/clerk-stub';
import { hasViteClerkKey } from '../helpers/clerk-key';
import {
  API_URL,
  bootstrapOwner,
  seedJob,
  createAndSendSimpleEstimate,
  queryAsTenant,
} from '../fixtures/estimate-quote-lane';

const SCREENSHOT_DIR = join(process.cwd(), 'docs/audit/lane-reports/8-7-quote-r5');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

/**
 * §8.7 row 7.10 — rung-5 reachability: "Given concurrent nudges for one
 * estimate, when dispatched, then exactly one send, cadence advances once,
 * audit rows written, a 48h cooldown respected, and a crash mid-send
 * recovers." This spec documents — and empirically demonstrates, not just
 * cites — why NEITHER real production entry point into
 * `dispatchEstimateNudge` (packages/api/src/estimates/estimate-nudge.ts) is
 * reachable in this hermetic e2e environment, so the row's correctness
 * claims stay pinned at the vitest-integration level
 * (test/integration/estimate-nudge.test.ts, 16 real-Postgres tests, T1·T4 —
 * already graded) rather than faked here with SQL or a platform-admin
 * shortcut.
 *
 * Entry point 1 — the AUTOMATIC sweep. `runEstimateReminderSweep`
 * (packages/api/src/workers/estimate-reminder-worker.ts) is driven by a
 * `setInterval` in app.ts (~line 6452, every 60 MINUTES of real wall-clock
 * time) and only nudges an estimate sent more than `reminderAfterDays`
 * (default 3 REAL days) ago (estimate-reminder-worker.ts:58,73). There is no
 * HTTP route that triggers a sweep on demand (grepped
 * packages/api/src/routes for "nudge"/"reminder" — the only hit is the
 * proposal-type string, not a route) and no injectable clock reaches this
 * worker from app.ts's wiring (`deps.now` is left undefined, so it always
 * reads the real `Date.now()`). Backdating `sent_at`/`last_reminder_at` with
 * SQL to fake the 3-day age is exactly the "no SQL writes to fake a state
 * the product should produce" rule this lane runs under — so this path
 * cannot be exercised hermetically at all, by design of this lane's rules,
 * not by omission.
 *
 * Entry point 2 — the OWNER-triggered `send_estimate_nudge` AI proposal
 * (routes/assistant.ts, RV-086's shared `dispatchEstimateNudge` call),
 * which WOULD be reachable through the real Assistant chat the way row 7.1's
 * spec drives `draft_estimate` — except `send_estimate_nudge` has no
 * deterministic pre-LLM phrase matcher (unlike `matchDraftEstimatePhrase`,
 * intent-classifier.ts:1702 — grepped for a `send_estimate_nudge` twin and
 * found none, only its enum entry and gate, routes/assistant.ts:931/2163).
 * Classifying "nudge/remind/follow up on that estimate" as the
 * `send_estimate_nudge` intent therefore depends on a REAL LLM call, and
 * this environment's production hermetic fallback (`scriptHermeticResponse`,
 * packages/api/src/ai/providers/mock.ts:158-190) only scripts
 * `create_customer` / `draft_estimate` / `create_invoice` / `unknown` for
 * `classify_intent` — no `send_estimate_nudge` branch. The test below drives
 * this for real and shows the mock answers `unknown`, so no proposal is
 * drafted.
 *
 * The estimate detail page's "Send follow-up" / "Send reminder" button
 * (EstimatesPage.tsx:1464) is NOT the same capability — it re-invokes the
 * plain `POST /api/estimates/:id/send` route, not `dispatchEstimateNudge`,
 * so it never touches `reminder_count` / `last_reminder_at` / the 48h
 * cooldown or emits the nudge-specific audit event this row is about; using
 * it here would be exactly the kind of "reachable-looking but not the
 * capability" substitution the lane's evidence rules forbid.
 */

test.describe('estimate nudge automation (7.10) — reachability finding, real Postgres', () => {
  const canRun =
    !process.env.E2E_BASE_URL &&
    hasViteClerkKey() &&
    process.env.E2E_USE_TEST_DB === 'true';
  test.skip(
    !canRun,
    'Requires the local webServer pair against a real Postgres.',
  );

  test('empirical proof: a chat-typed nudge request is classified `unknown` by the production hermetic mock, so no send_estimate_nudge proposal is ever drafted', async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);
    const tenant = await bootstrapOwner(request, 'a', 'Acme HVAC 7.10');
    const job = await seedJob(request, tenant, 'Nudge');
    const sent = await createAndSendSimpleEstimate(request, tenant, job, 14_900);

    await installClerkStub(page, { signedIn: true, sub: tenant.sub, token: tenant.jwt });
    await page.goto('/assistant');
    const textarea = page.getByPlaceholder(/Ask anything or give a command/i);
    await expect(textarea).toBeVisible({ timeout: 20_000 });
    await textarea.fill(`Please nudge the customer about estimate ${sent.estimateId} — they haven't responded.`);
    await textarea.press('Enter');

    // Give the (real, unmocked-by-this-test) round trip time to answer, then
    // confirm NO proposal card — specifically no Approve affordance — ever
    // appears, matching the `unknown`-intent, no-drafting-handler-invoked
    // prediction.
    await page.waitForTimeout(4_000);
    await expect(page.getByRole('button', { name: /^Approve$/ })).toHaveCount(0);
    await page.screenshot({ path: join(SCREENSHOT_DIR, '7.10-chat-nudge-no-proposal-drafted.png') });

    const proposals = await queryAsTenant(
      tenant.tenantId,
      `SELECT id FROM proposals WHERE tenant_id = $1 AND proposal_type = 'callback' AND summary ILIKE '%nudge%'`,
      [tenant.tenantId],
    );
    expect(proposals, 'no send_estimate_nudge-shaped proposal is ever drafted from chat text').toHaveLength(0);

    // The estimate itself is completely unaffected — no reminder fired.
    const row = await queryAsTenant(
      tenant.tenantId,
      `SELECT reminder_count, last_reminder_at FROM estimates WHERE id = $1`,
      [sent.estimateId],
    );
    expect(Number(row[0]?.reminder_count ?? 0)).toBe(0);
    expect(row[0]?.last_reminder_at ?? null).toBeNull();
  });

  test('NOT reachable hermetically: the automatic 3-day/60-minute sweep and true concurrent-dispatch racing', () => {
    test.fail(
      true,
      'packages/api/src/app.ts:6446-6466 drives runEstimateReminderSweep on a 60-real-minute ' +
        'setInterval with no HTTP trigger route and no injectable clock (deps.now left undefined); ' +
        'estimate-reminder-worker.ts:58,73 additionally gates on 3 REAL days since sent_at. Neither ' +
        'can be exercised in a Playwright run without either waiting 3+ real days, or backdating ' +
        'sent_at/last_reminder_at with SQL — forbidden by this lane\'s "no SQL writes to fake a ' +
        'state the product should produce" rule. The correctness claims themselves (exactly one ' +
        'send under real concurrency, cadence advances once, the 48h cooldown, crash-mid-send ' +
        'recovery via the claim ledger) stay proven at the vitest-integration level: ' +
        'test/integration/estimate-nudge.test.ts (16 tests, real Postgres, T1) and ' +
        'test/integration/sweep-tenant-fanout.test.ts (the estimate-reminder sweep entry, T4).',
    );
    expect(true).toBe(false);
  });
});

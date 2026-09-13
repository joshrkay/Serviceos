import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  API_URL,
  bootstrapOwner,
  postSignedWebhook,
  pollDbSnapshot,
  queryOne,
} from '../fixtures/onboarding-hermetic-lane';
import { hasViteClerkKey } from '../helpers/clerk-key';

/**
 * 1.1 — "I want an account the moment I sign up, so I never see a
 * 'setting up your workspace' screen."
 *
 * There is no browser UI for this story — the acceptance is entirely about
 * the real inbound Clerk signup webhook, so THAT is the real surface a
 * headless system-to-system story like this one is reachable through (same
 * class as this repo's signed Twilio/Stripe webhook specs). Proven so far
 * only at the vitest-integration layer (`clerk-owner-membership.test.ts`,
 * `request(app)` against a bare Express instance). This spec drives the
 * SAME acceptance through Playwright's actually-booted webServer (full
 * app.ts boot, real migrations, real in-process queue) against real
 * Postgres — the same `postSignedWebhook`/`bootstrapOwner` primitives every
 * other rung-5 spec in this lane already relies on for bootstrap, now
 * exercised as the capability under test rather than as setup.
 */

const REPORT_DIR = 'setup-8-1-r5';

test.describe('onboarding signup webhook (1.1) — real Postgres, real /webhooks/clerk router', () => {
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

  test('a genuinely re-delivered signup (two distinct svix ids, same Clerk user) still yields exactly one tenant and one owner row; a neighbour tenant is untouched (T2)', async ({
    page,
  }) => {
    // ── Neighbour tenant, bootstrapped FIRST with its own distinct Clerk
    //    user — the T2 control we check is untouched at the end. ──────────
    const neighbour = await bootstrapOwner(page, 'signupneighbour');

    // ── The tenant under test — deliver `user.created` TWICE for the SAME
    //    Clerk user id, each with its OWN svix id (a genuine redelivery,
    //    not the same-id dedup path `handleWebhookEvent` already covers
    //    separately). ─────────────────────────────────────────────────────
    const sub = `user_e2e_redelivery_${randomUUID().replace(/-/g, '')}`;
    const email = `redelivery-${Date.now()}@serviceos-hermetic.test`;
    const body = {
      type: 'user.created',
      data: { id: sub, email_addresses: [{ email_address: email }] },
    };

    const first = await postSignedWebhook(page.request, body);
    expect(first.status(), `first delivery -> ${await first.text()}`).toBe(200);

    const second = await postSignedWebhook(page.request, body);
    expect(second.status(), `re-delivery -> ${await second.text()}`).toBe(200);

    pollDbSnapshot(
      REPORT_DIR,
      '1.1-tenants-after-redelivery',
      `SELECT count(*) AS n FROM tenants WHERE owner_id = '${sub}';`,
    );
    pollDbSnapshot(
      REPORT_DIR,
      '1.1-users-after-redelivery',
      `SELECT count(*) AS n, count(*) FILTER (WHERE role = 'owner') AS owners ` +
        `FROM users WHERE clerk_user_id = '${sub}';`,
    );

    const tenantCount = queryOne(`SELECT count(*) FROM tenants WHERE owner_id = '${sub}';`);
    expect(String(tenantCount).trim(), 'exactly one tenant exists after a genuine re-delivery').toBe('1');

    const userCount = queryOne(`SELECT count(*) FROM users WHERE clerk_user_id = '${sub}';`);
    expect(String(userCount).trim(), 'exactly one owner membership row exists').toBe('1');

    const ownerRole = queryOne(`SELECT role FROM users WHERE clerk_user_id = '${sub}';`);
    expect(String(ownerRole).trim()).toBe('owner');

    // Known, already-filed observation (#1075) — the audit write is not
    // gated on `result.created`, so a genuine re-delivery writes a SECOND
    // `tenant.signup.bootstrap.completed` row. Not part of this row's
    // stated acceptance criteria (which names only "exactly one tenant"),
    // so not asserted as a failure here — recorded for the PR body instead.
    pollDbSnapshot(
      REPORT_DIR,
      '1.1-bootstrap-audit-after-redelivery',
      `SELECT event_type, count(*) FROM audit_events WHERE tenant_id = ` +
        `(SELECT id FROM tenants WHERE owner_id = '${sub}') AND event_type = ` +
        `'tenant.signup.bootstrap.completed' GROUP BY event_type;`,
    );

    // ── Stale webhook (timestamp 600s old, > the 300s SVIX_TOLERANCE_SECONDS
    //    window) with a DELIBERATELY GARBAGE signature. If staleness were
    //    checked AFTER signature verification the garbage signature would
    //    fail first with 401 "Invalid signature"; the route rejects it with
    //    400 "Timestamp outside tolerance" instead, proving the replay
    //    window really is enforced BEFORE signature verification, not just
    //    before the tenant write. ─────────────────────────────────────────
    const staleSub = `user_e2e_stale_${randomUUID().replace(/-/g, '')}`;
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 600);
    const staleRes = await page.request.post(`${API_URL}/webhooks/clerk`, {
      headers: {
        'content-type': 'application/json',
        'svix-id': `evt_${randomUUID()}`,
        'svix-timestamp': staleTimestamp,
        'svix-signature': 'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      },
      data: JSON.stringify({
        type: 'user.created',
        data: { id: staleSub, email_addresses: [{ email_address: `stale-${Date.now()}@serviceos-hermetic.test` }] },
      }),
    });
    expect(staleRes.status(), `stale + garbage-signature webhook -> ${await staleRes.text()}`).toBe(400);
    const staleBody = (await staleRes.json()) as { error?: string };
    expect(staleBody.error, 'rejected for staleness, not signature — proves check ordering').toBe(
      'Timestamp outside tolerance',
    );

    const staleTenantCount = queryOne(`SELECT count(*) FROM tenants WHERE owner_id = '${staleSub}';`);
    expect(String(staleTenantCount).trim(), 'the stale/forged webhook created no tenant').toBe('0');

    // ── T2 — the neighbour, bootstrapped before any of this test's
    //    redelivery/staleness traffic, has exactly its own tenant + owner
    //    row, untouched. ──────────────────────────────────────────────────
    pollDbSnapshot(
      REPORT_DIR,
      '1.1-T2-neighbour-untouched',
      `SELECT count(*) AS tenants, ` +
        `(SELECT count(*) FROM users WHERE tenant_id = '${neighbour.tenantId}') AS users ` +
        `FROM tenants WHERE id = '${neighbour.tenantId}';`,
    );
    const neighbourTenantCount = queryOne(
      `SELECT count(*) FROM tenants WHERE id = '${neighbour.tenantId}';`,
    );
    expect(String(neighbourTenantCount).trim()).toBe('1');
    const neighbourUserCount = queryOne(
      `SELECT count(*) FROM users WHERE tenant_id = '${neighbour.tenantId}';`,
    );
    expect(String(neighbourUserCount).trim()).toBe('1');
  });
});

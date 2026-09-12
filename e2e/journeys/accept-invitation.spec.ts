import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { installClerkStub } from '../helpers/clerk-stub';
import { blockExternalHosts } from '../helpers/api-mocks/shell';
import { hasViteClerkKey } from '../helpers/clerk-key';

/**
 * 1.11 — `/accept-invitation` route reachability.
 *
 * `inviteTeamMember` (packages/api/src/users/invite-team-member.ts:56)
 * redirects an accepted invitee to
 * `${appBaseUrl}/accept-invitation?invitation_id=<id>` — but the web router
 * had no such route, so every invited teammate 404'd instead of reaching the
 * app.
 *
 * The real acceptance happens server-side, via Clerk's `user.created`
 * webhook (webhooks/routes.ts) joining the invitee to the inviting tenant —
 * a Postgres-only code path (it 500s without a real pool: "pool not
 * configured for invitee join"). This spec proves the FULL loop against a
 * real Postgres container:
 *
 *   1. Bootstrap an owner via a signed `user.created` webhook (hermetic
 *      pattern — e2e/journeys/signup-to-first-estimate.hermetic.spec.ts),
 *      bind the browser to that owner via DEV_AUTH_BYPASS's unsigned-JWT
 *      shortcut, and clear the onboarding soft gate.
 *   2. As that owner, POST the REAL /api/users/invitations route (the one
 *      SettingsPage's "Invite" action uses) to invite a technician by email.
 *   3. Simulate Clerk's invitation-acceptance webhook: POST another SIGNED
 *      `user.created` event for a NEW clerk_user_id, carrying
 *      `public_metadata.invitation_id` — exactly the payload
 *      `inviteTeamMember` sends to Clerk's real Invitations API. The REAL
 *      webhook handler joins this user to the SAME tenant with role
 *      'technician', which DEV_AUTH_BYPASS's per-sub tenant auto-bootstrap
 *      cannot express (it only ever resolves a session to a tenant the sub
 *      OWNS) — so the technician's browser session instead carries an
 *      HMAC-signed token with an explicit `tenant_id` claim, verified by
 *      `verifyClerkSession`'s CLERK_DEV_HMAC_TOKENS dev path.
 *   4. Visit `/accept-invitation?invitation_id=<id>` as that technician and
 *      confirm the SPA lands on `/technician/day` (RoleHome's existing
 *      per-role split) instead of 404ing.
 *
 * Requires: local webServer pair (E2E_BASE_URL unset), a Vite Clerk key
 * (placeholder ok), E2E_USE_TEST_DB=true + DATABASE_URL pointing at a real
 * Postgres (the invitee-join webhook path requires a pool), and
 * CLERK_DEV_HMAC_TOKENS=true so the technician's tenant-scoped HMAC token
 * verifies (see the lane README for the exact command).
 */

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3000';

const CLERK_WEBHOOK_SECRET =
  process.env.E2E_CLERK_WEBHOOK_SECRET ??
  'whsec_dGVzdC1zaWdudXAtY3JpdGljYWwtcGF0aA==';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

/** Unsigned `header.payload.sig` JWT — what DEV_AUTH_BYPASS decodes without verifying. */
function unsignedJwt(sub: string): string {
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({
    sub,
    sid: 'dev-session',
    role: 'owner',
  })}.x`;
}

/**
 * HMAC-SHA256 dev token carrying an EXPLICIT tenant_id claim (verified by
 * verifyClerkSession's CLERK_DEV_HMAC_TOKENS path — packages/api/src/auth/clerk.ts
 * decodeClerkToken). Unlike the unsigned-JWT DEV_AUTH_BYPASS shortcut (which
 * always resolves a sub to the tenant IT OWNS, auto-bootstrapping a new one
 * otherwise), this lets a non-owner member's session carry the tenant it was
 * actually invited into. Signed with '' to match `CLERK_SECRET_KEY ?? ''`
 * when the API runs with no real Clerk secret configured (avoids the
 * webhook handler's best-effort real-Clerk PATCH call, which only fires
 * `if (config.CLERK_SECRET_KEY)`).
 */
function hmacToken(sub: string, tenantId: string, role: string): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    sub,
    sid: `e2e-session-${sub}`,
    tenant_id: tenantId,
    role,
    exp: Math.floor(Date.now() / 1000) + 60 * 60,
  };
  const input = `${b64url(header)}.${b64url(payload)}`;
  const sig = createHmac('sha256', Buffer.from('')).update(input).digest('base64url');
  return `${input}.${sig}`;
}

/** svix `v1,<base64 HMAC>` over `${id}.${ts}.${body}` (mirrors the hermetic Journey-1 spec). */
function signSvix(rawBody: string, svixId: string, svixTimestamp: string): string {
  const secret = Buffer.from(CLERK_WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  const sig = createHmac('sha256', secret)
    .update(`${svixId}.${svixTimestamp}.${rawBody}`)
    .digest('base64');
  return `v1,${sig}`;
}

async function postSignedWebhook(
  request: import('@playwright/test').APIRequestContext,
  body: Record<string, unknown>,
) {
  const svixId = `evt_${randomUUID()}`;
  const svixTimestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = JSON.stringify(body);
  const res = await request.post(`${API_URL}/webhooks/clerk`, {
    headers: {
      'content-type': 'application/json',
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': signSvix(rawBody, svixId, svixTimestamp),
    },
    data: rawBody,
  });
  return res;
}

test.describe('accept-invitation (1.11) — real Postgres', () => {
  // Needs the LOCAL webServer pair (E2E_BASE_URL unset) — same gate as the
  // hermetic Journey-1 signup spec — plus a real Postgres behind it (the
  // invitee-join webhook path 500s on the in-memory backend by design).
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

  test('an unauthenticated visit does not land on the technician day view (route + auth-gate sanity)', async ({
    page,
  }) => {
    // Signed-out stub (not "no stub at all"): the real Clerk CDN can't
    // initialize against the placeholder publishable key in this offline
    // run, which would otherwise hang ProtectedRoute's `!isLoaded` branch
    // forever. installClerkStub({signedIn:false}) is the established
    // offline-signed-out idiom (e2e/no-401-storm.spec.ts and others).
    await installClerkStub(page, { signedIn: false });
    await page.goto(`/accept-invitation?invitation_id=${randomUUID()}`);
    // ProtectedRoute's existing unauthenticated handling takes over once the
    // route exists: redirected to /login (never a 404, never the day view).
    await expect(page).toHaveURL(/\/login/);
  });

  test('an invited technician follows the invite link and lands on their own day view', async ({
    page,
    baseURL,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // ── 1. Bootstrap the OWNER's tenant (hermetic webhook, DEV_AUTH_BYPASS) ──
    const ownerSub = `user_e2e_owner_${randomUUID().replace(/-/g, '')}`;
    const ownerEmail = `owner-${Date.now()}@serviceos-hermetic.test`;
    const ownerJwt = unsignedJwt(ownerSub);
    const ownerHeaders = { Authorization: `Bearer ${ownerJwt}` };

    const bootstrapRes = await postSignedWebhook(page.request, {
      type: 'user.created',
      data: { id: ownerSub, email_addresses: [{ email_address: ownerEmail }] },
    });
    expect(bootstrapRes.status(), `owner bootstrap webhook -> ${await bootstrapRes.text()}`).toBe(200);

    const meRes = await page.request.get(`${API_URL}/api/me`, { headers: ownerHeaders });
    expect(meRes.status(), `/api/me failed: ${await meRes.text()}`).toBe(200);
    const me = (await meRes.json()) as { tenant_id?: string };
    expect(me.tenant_id).toMatch(UUID_RE);
    const tenantId = me.tenant_id!;

    // ── 2. Clear the onboarding soft gate (OnboardingGuard would otherwise
    //      bounce EVERY signed-in member of this tenant — including the
    //      invited technician below — to /onboarding). ──────────────────────
    const identityRes = await page.request.put(`${API_URL}/api/onboarding/identity`, {
      headers: { 'content-type': 'application/json', ...ownerHeaders },
      data: JSON.stringify({
        businessName: 'Accept Invitation E2E HVAC',
        businessHours: { mon: { open: '08:00', close: '17:00' }, sat: null, sun: null },
        jobBufferMinutes: 30,
        hourlyRateCents: 12500,
        timezone: 'America/Chicago',
      }),
    });
    expect(identityRes.ok(), `PUT /api/onboarding/identity -> ${identityRes.status()}`).toBeTruthy();

    // ── 3. As the owner, invite a technician through the REAL route the
    //      SettingsPage "Invite" action uses. ──────────────────────────────
    const techEmail = `tech-${Date.now()}@serviceos-hermetic.test`;
    const inviteRes = await page.request.post(`${API_URL}/api/users/invitations`, {
      headers: { 'content-type': 'application/json', ...ownerHeaders },
      data: JSON.stringify({ email: techEmail, role: 'technician' }),
    });
    expect(inviteRes.status(), `POST /api/users/invitations -> ${await inviteRes.text()}`).toBe(201);
    const invitation = (await inviteRes.json()) as { id?: string };
    expect(invitation.id, 'invite response must carry the local invitation id').toBeTruthy();
    const invitationId = invitation.id!;

    // ── 4. Simulate the invitee's Clerk sign-up completing: a signed
    //      user.created webhook carrying public_metadata.invitation_id —
    //      exactly the payload inviteTeamMember posts to Clerk's real
    //      Invitations API (invite-team-member.ts). The REAL handler joins
    //      this NEW clerk_user_id to the SAME tenant with role technician. ──
    const techSub = `user_e2e_tech_${randomUUID().replace(/-/g, '')}`;
    const joinRes = await postSignedWebhook(page.request, {
      type: 'user.created',
      data: {
        id: techSub,
        email_addresses: [{ email_address: techEmail }],
        public_metadata: { invitation_id: invitationId, tenant_id: tenantId, role: 'technician' },
      },
    });
    expect(joinRes.status(), `invitee-join webhook -> ${await joinRes.text()}`).toBe(200);
    const joinBody = (await joinRes.json()) as { joined?: string };
    expect(joinBody.joined, 'webhook must report the tenant it joined the invitee into').toBe(tenantId);

    // ── 5. Bind the BROWSER session to the technician — an HMAC token with
    //      an explicit tenant_id claim (see hmacToken doc comment above). ──
    const techToken = hmacToken(techSub, tenantId, 'technician');
    await installClerkStub(page, { signedIn: true, sub: techSub, token: techToken });
    await blockExternalHosts(page, baseURL!);

    // ── 6. Visit the invite link and confirm it reaches the day view. ──────
    await page.goto(`/accept-invitation?invitation_id=${invitationId}`);
    await expect(page).toHaveURL(/\/technician\/day/, { timeout: 15_000 });
    await expect(page.getByTestId('technician-day-view')).toBeVisible({ timeout: 15_000 });

    expect(pageErrors, 'no uncaught page errors during the accept-invitation journey').toEqual([]);
  });
});

import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { installClerkStub } from '../helpers/clerk-stub';
import { blockExternalHosts } from '../helpers/api-mocks/shell';
import { hasViteClerkKey } from '../helpers/clerk-key';

/** Scalar `psql -tA` read, trimmed. Returns '' if DATABASE_URL is unset. */
function queryScalar(sql: string): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return '';
  return execFileSync('psql', [databaseUrl, '-t', '-A', '-c', sql], { encoding: 'utf8' }).trim();
}

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
    baseURL,
  }) => {
    // Signed-out stub (not "no stub at all"): the real Clerk CDN can't
    // initialize against the placeholder publishable key in this offline
    // run, which would otherwise hang ProtectedRoute's `!isLoaded` branch
    // forever. installClerkStub({signedIn:false}) is the established
    // offline-signed-out idiom (e2e/no-401-storm.spec.ts and others).
    await installClerkStub(page, { signedIn: false });
    // index.html eagerly loads a blocking Google Fonts stylesheet + a Pendo
    // script tag from external hosts; in a network-sandboxed lane those
    // never resolve, stalling the page's `load` event past the default
    // navigationTimeout. Every other spec in this file (and this whole
    // suite) already blocks non-app origins before navigating — this test
    // was the one gap, surfaced by running it in a fully offline sandbox.
    await blockExternalHosts(page, baseURL!);
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

  // ── T2 leg (#995 rung-5 map, row 1.11) ─────────────────────────────────────

  test('T2 — tenant B\'s invitation token does not open tenant A\'s join', async ({ page }) => {
    // ── Tenant A: exists in the same run, never gets this invitee. ──────────
    const ownerASub = `user_e2e_ownerA_${randomUUID().replace(/-/g, '')}`;
    const ownerAEmail = `ownerA-${Date.now()}@serviceos-hermetic.test`;
    const ownerABootstrap = await postSignedWebhook(page.request, {
      type: 'user.created',
      data: { id: ownerASub, email_addresses: [{ email_address: ownerAEmail }] },
    });
    expect(ownerABootstrap.status()).toBe(200);
    const ownerAMe = await page.request.get(`${API_URL}/api/me`, {
      headers: { Authorization: `Bearer ${unsignedJwt(ownerASub)}` },
    });
    const tenantA = ((await ownerAMe.json()) as { tenant_id?: string }).tenant_id!;
    expect(tenantA).toMatch(UUID_RE);

    // ── Tenant B: the actual inviter. ────────────────────────────────────────
    const ownerBSub = `user_e2e_ownerB_${randomUUID().replace(/-/g, '')}`;
    const ownerBEmail = `ownerB-${Date.now()}@serviceos-hermetic.test`;
    const ownerBJwt = unsignedJwt(ownerBSub);
    const ownerBHeaders = { Authorization: `Bearer ${ownerBJwt}` };
    const ownerBBootstrap = await postSignedWebhook(page.request, {
      type: 'user.created',
      data: { id: ownerBSub, email_addresses: [{ email_address: ownerBEmail }] },
    });
    expect(ownerBBootstrap.status()).toBe(200);
    const ownerBMe = await page.request.get(`${API_URL}/api/me`, { headers: ownerBHeaders });
    const tenantB = ((await ownerBMe.json()) as { tenant_id?: string }).tenant_id!;
    expect(tenantB).toMatch(UUID_RE);
    expect(tenantB).not.toBe(tenantA);

    const techEmail = `crosstenant-tech-${Date.now()}@serviceos-hermetic.test`;
    const inviteRes = await page.request.post(`${API_URL}/api/users/invitations`, {
      headers: { 'content-type': 'application/json', ...ownerBHeaders },
      data: JSON.stringify({ email: techEmail, role: 'technician' }),
    });
    expect(inviteRes.status(), `POST /api/users/invitations -> ${await inviteRes.text()}`).toBe(201);
    const invitation = (await inviteRes.json()) as { id?: string };
    const invitationIdForB = invitation.id!;

    // ── The attack: a signed user.created webhook carrying tenant B's REAL
    //    invitation_id, but a public_metadata.tenant_id claim FORGED to
    //    tenant A. The join must resolve the tenant from the invitation
    //    row itself (pending.tenantId), never from this claim. ──────────────
    const techSub = `user_e2e_crosstenant_${randomUUID().replace(/-/g, '')}`;
    const joinRes = await postSignedWebhook(page.request, {
      type: 'user.created',
      data: {
        id: techSub,
        email_addresses: [{ email_address: techEmail }],
        public_metadata: { invitation_id: invitationIdForB, tenant_id: tenantA, role: 'technician' },
      },
    });
    expect(joinRes.status(), `invitee-join webhook -> ${await joinRes.text()}`).toBe(200);
    const joinBody = (await joinRes.json()) as { joined?: string };
    expect(
      joinBody.joined,
      'the forged tenant_id claim must be ignored — the invitee joins the invitation\'s REAL tenant (B), never A',
    ).toBe(tenantB);
    expect(joinBody.joined).not.toBe(tenantA);

    // ── Confirm via the real API: the new user is a member of tenant B and
    //    of tenant B ONLY — tenant A never sees this user. ──────────────────
    const techToken = hmacToken(techSub, tenantB, 'technician');
    const techMe = await page.request.get(`${API_URL}/api/me`, {
      headers: { Authorization: `Bearer ${techToken}` },
    });
    expect(techMe.status(), `technician /api/me -> ${await techMe.text()}`).toBe(200);
    const techMeBody = (await techMe.json()) as { tenant_id?: string };
    expect(techMeBody.tenant_id).toBe(tenantB);

    // ── The durable proof, direct from Postgres: exactly one `users` row for
    //    this clerk_user_id, and it belongs to tenant B — none under tenant
    //    A. `/api/me` under DEV_AUTH_BYPASS would happily echo back whatever
    //    tenant_id a forged token claims without a DB membership check (see
    //    row 4.4's report section on this same gap), so a status-code-only
    //    assertion against a forged tenant-A token proves nothing here —
    //    reading the table itself is the only assertion that can't be
    //    satisfied by a false membership. ────────────────────────────────────
    const tenantAMatches = queryScalar(
      `SELECT count(*) FROM users WHERE clerk_user_id = '${techSub}' AND tenant_id = '${tenantA}';`,
    );
    expect(tenantAMatches, 'tenant A must have NO users row for this invitee').toBe('0');
    const tenantBMatches = queryScalar(
      `SELECT count(*) FROM users WHERE clerk_user_id = '${techSub}' AND tenant_id = '${tenantB}';`,
    );
    expect(tenantBMatches, 'tenant B must have exactly one users row for this invitee').toBe('1');
  });

  test('T2 — the last owner cannot be demoted from the members page (UI)', async ({ page, baseURL }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    const ownerSub = `user_e2e_soleowner_${randomUUID().replace(/-/g, '')}`;
    const ownerEmail = `soleowner-${Date.now()}@serviceos-hermetic.test`;
    const ownerJwt = unsignedJwt(ownerSub);
    const ownerHeaders = { Authorization: `Bearer ${ownerJwt}` };

    const bootstrapRes = await postSignedWebhook(page.request, {
      type: 'user.created',
      data: { id: ownerSub, email_addresses: [{ email_address: ownerEmail }] },
    });
    expect(bootstrapRes.status()).toBe(200);

    const meRes = await page.request.get(`${API_URL}/api/me`, { headers: ownerHeaders });
    const me = (await meRes.json()) as { tenant_id?: string; internal_user_id?: string };
    expect(me.tenant_id).toMatch(UUID_RE);
    const ownerInternalId = me.internal_user_id!;
    expect(ownerInternalId).toMatch(UUID_RE);

    const identityRes = await page.request.put(`${API_URL}/api/onboarding/identity`, {
      headers: { 'content-type': 'application/json', ...ownerHeaders },
      data: JSON.stringify({
        businessName: 'Sole Owner E2E HVAC',
        businessHours: { mon: { open: '08:00', close: '17:00' }, sat: null, sun: null },
        jobBufferMinutes: 30,
        hourlyRateCents: 12500,
        timezone: 'Etc/UTC',
      }),
    });
    expect(identityRes.ok()).toBeTruthy();

    await installClerkStub(page, { signedIn: true, sub: ownerSub, token: ownerJwt });
    await page.addInitScript(
      ({ welcomeKey, whatsNewKey }) => {
        try {
          localStorage.setItem(welcomeKey, '1');
          localStorage.setItem(whatsNewKey, '2026-06-21-onboarding');
        } catch {
          /* private mode — ignore */
        }
      },
      { welcomeKey: 'walkthrough.welcome.v1', whatsNewKey: 'walkthrough.whatsnew.lastSeen' },
    );
    await blockExternalHosts(page, baseURL!);
    await page.goto('/settings');

    await page.getByRole('button', { name: /Team members/i }).click();
    const dialog = page.getByRole('dialog', { name: 'Team members' });
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByTestId(`team-member-row-${ownerInternalId}`)).toBeVisible({ timeout: 15_000 });

    await page.screenshot({
      path: 'docs/audit/lane-reports/owner-surfaces-r5/1.11-last-owner-demote-before.png',
      fullPage: true,
    });

    await dialog.getByTestId(`team-member-edit-${ownerInternalId}`).click();
    await dialog.getByTestId(`team-member-role-select-${ownerInternalId}`).selectOption('dispatcher');

    const patchPromise = page.waitForResponse(
      (r) => r.request().method() === 'PATCH' && new URL(r.url()).pathname === `/api/users/${ownerInternalId}`,
    );
    await dialog.getByRole('button', { name: 'Save' }).click();
    const patchRes = await patchPromise;
    expect(patchRes.status(), 'demoting the only owner must be refused, not succeed').toBe(400);

    const alert = dialog.getByRole('alert');
    await expect(alert).toBeVisible({ timeout: 10_000 });
    await expect(alert).toContainText(/only owner|Cannot demote/i);

    // The role must NOT have changed — the row still shows Owner.
    await expect(dialog.getByTestId(`team-member-row-${ownerInternalId}`)).toContainText('Owner');

    await page.screenshot({
      path: 'docs/audit/lane-reports/owner-surfaces-r5/1.11-last-owner-demote-after.png',
      fullPage: true,
    });

    const stillOwnerRes = await page.request.get(`${API_URL}/api/me`, { headers: ownerHeaders });
    const stillOwner = (await stillOwnerRes.json()) as { role?: string };
    expect(stillOwner.role, 'the sole owner\'s role must be unchanged after the refused demotion').toBe('owner');

    expect(pageErrors, 'no uncaught page errors during the last-owner demotion attempt').toEqual([]);
  });

  test('T1 — an owner cannot PATCH another tenant\'s user (the last-owner guard\'s endpoint is itself tenant-scoped)', async ({
    page,
  }) => {
    // ── REGRESSION GUARD for the #1092 cross-tenant privilege escalation ───
    // This leg was written here as a pinned RED (`test.fail(true, …)`) when
    // the owner-surfaces lane discovered, empirically at real Postgres, that
    // `PgUserRepository.update` ran
    // `UPDATE users SET … WHERE id = $N AND deleted_at IS NULL` with NO
    // `tenant_id` predicate — unlike every sibling method in the same file
    // (`findById`, `findByMobileNumber` — whose own doc comment promises
    // "Defense-in-depth: the WHERE clause filters on tenant_id explicitly in
    // addition to RLS" — `demoteOwnerIfAnotherExists`, and the rest). It backs
    // `PATCH /api/users/:id`, gated only by
    // `requirePermission('users:edit_role')`, so ANY owner could change the
    // role (or name / canFieldServe) of ANY user in ANY other tenant, sole
    // owners included: this very request returned 200 and demoted tenant B's
    // owner.
    //
    // Fixed in #1092 / PR #1093 by adding `AND tenant_id = $N` to that WHERE,
    // so the pin is gone and the leg now stands as an ordinary passing
    // regression test — the cross-tenant PATCH must 404 and leave tenant B's
    // row untouched, checked through the API and by reading the row straight
    // out of Postgres.
    //
    // The predicate, not RLS, is what this proves. `RLS_RUNTIME_ROLE=true` is
    // a hard prod/staging boot requirement (SEC-01,
    // packages/api/src/shared/config.ts) and would have masked the defect in a
    // correctly configured deployment — but this hermetic harness runs with the
    // flag OFF, exactly like local dev, which is why the hole was reachable
    // here and why the app-layer predicate has to hold on its own. See
    // docs/audit/lane-reports/1092-users-update-tenant-predicate.md.
    // ── Tenant A ──────────────────────────────────────────────────────────
    const ownerASub = `user_e2e_ownera2_${randomUUID().replace(/-/g, '')}`;
    const ownerAEmail = `ownera2-${Date.now()}@serviceos-hermetic.test`;
    const ownerAHeaders = { Authorization: `Bearer ${unsignedJwt(ownerASub)}` };
    const bootstrapA = await postSignedWebhook(page.request, {
      type: 'user.created',
      data: { id: ownerASub, email_addresses: [{ email_address: ownerAEmail }] },
    });
    expect(bootstrapA.status()).toBe(200);
    const meA = await page.request.get(`${API_URL}/api/me`, { headers: ownerAHeaders });
    expect(meA.status()).toBe(200);

    // ── Tenant B, same run: its own sole owner. ──────────────────────────────
    const ownerBSub = `user_e2e_ownerb2_${randomUUID().replace(/-/g, '')}`;
    const ownerBEmail = `ownerb2-${Date.now()}@serviceos-hermetic.test`;
    const ownerBHeaders = { Authorization: `Bearer ${unsignedJwt(ownerBSub)}` };
    const bootstrapB = await postSignedWebhook(page.request, {
      type: 'user.created',
      data: { id: ownerBSub, email_addresses: [{ email_address: ownerBEmail }] },
    });
    expect(bootstrapB.status()).toBe(200);
    const meBRes = await page.request.get(`${API_URL}/api/me`, { headers: ownerBHeaders });
    expect(meBRes.status()).toBe(200);
    const meB = (await meBRes.json()) as { internal_user_id?: string };
    expect(meB.internal_user_id).toMatch(UUID_RE);
    const ownerBInternalId = meB.internal_user_id!;

    // ── Tenant A's owner PATCHes tenant B's owner id directly. Per
    //    routes/users.ts, `updateUser(req.auth!.tenantId, req.params.id, ...)`
    //    scopes the lookup by the CALLER's OWN tenant — B's user row simply
    //    isn't visible under A's tenant_id, so this is a 404, not the 400
    //    the SAME-tenant last-owner guard returns. ────────────────────────────
    const crossTenantPatch = await page.request.patch(`${API_URL}/api/users/${ownerBInternalId}`, {
      headers: { 'content-type': 'application/json', ...ownerAHeaders },
      data: JSON.stringify({ role: 'dispatcher' }),
    });
    expect(
      crossTenantPatch.status(),
      'tenant A must not be able to reach (let alone change the role of) tenant B\'s user',
    ).toBe(404);

    // ── B's owner role must be completely unaffected — checked both via the
    //    API and by reading the row directly from Postgres. ─────────────────
    const meBAfter = await page.request.get(`${API_URL}/api/me`, { headers: ownerBHeaders });
    const meBAfterBody = (await meBAfter.json()) as { role?: string };
    expect(meBAfterBody.role, 'tenant B\'s owner role must be unchanged after the cross-tenant PATCH attempt').toBe(
      'owner',
    );
    expect(
      queryScalar(`SELECT role FROM users WHERE id = '${ownerBInternalId}';`),
      'tenant B\'s owner role column in Postgres must be unchanged',
    ).toBe('owner');
  });
});

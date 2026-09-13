/**
 * §8.5 row 5.2 (ticket #1018) — rung-5 reachability: "before/after photos
 * attached to the job, before/after pairing survives" — reached through the
 * REAL technician job screen (not just the real-Postgres API round trip
 * `packages/api/test/integration/job-photo-round-trip.test.ts` already
 * proves at rung 4/T1).
 *
 * Surface named by the story: the technician's job-detail screen
 * (`packages/web/src/components/jobs/TechJobView.tsx`, reached via
 * `/technician/day` -> `technician-day-view-job` -> `/jobs/:id?view=tech`)
 * and its camera sheet (`packages/web/src/components/shared/CameraCapture.tsx`).
 *
 * HONEST STOP POINT, found while writing this spec (do not fake it, per the
 * lane's instructions): `TechJobView.handleCameraClose` (TechJobView.tsx:922)
 * hardcodes every still photo captured through this screen's camera sheet to
 * category `'before'`:
 *
 *   const category: JobPhotoCategory = m.type === 'video' ? 'other' : 'before';
 *
 * There is no in-screen affordance to tag a photo `'after'` — the only
 * component with a category selector is `JobPhotoUploader.tsx`
 * (data-testid `job-photo-category-select`), which is NOT wired into
 * `TechJobView` or any technician-reachable route. It is mounted solely on
 * `/jobs/:id/photos` (`packages/web/src/pages/jobs/JobPhotos.tsx`), whose own
 * header comment says the integration into the canonical job detail "is
 * intentionally deferred per the story's constraint". `/jobs/:id/photos` is
 * a generic authenticated route (any role with `jobs:view`), not technician-
 * branded, and nothing on the technician job screen links to it.
 *
 * So: rung-5 reachability for ATTACHING a 'before' photo through the named
 * surface is proven below, end to end, real camera capture included. Rung-5
 * reachability for the 'after' half of "before/after pairing" is NOT
 * reachable through the surface this story names — this spec proves that
 * negative (no category control exists on this screen) rather than routing
 * around it via the disconnected `/jobs/:id/photos` page and mislabeling
 * that as "the technician job screen".
 *
 * Camera: real `getUserMedia` via Chromium's fake video/audio device
 * (`--use-fake-device-for-media-stream`), not a mock — CameraCapture's own
 * `takePhoto()` draws the fake device's video frame to a real `<canvas>`
 * and produces a real JPEG data URL, exactly as it would from a real camera.
 *
 * Storage: presign -> PUT -> attach against whichever `StorageProvider`
 * `createStorageProvider()` selects for this run's env (S3-shaped vars unset
 * here, so `DevStorageProvider`, packages/api/src/files/storage-provider.ts).
 * Its dev PUT receiver (`routes/files.ts` `createDevStorageRouter`) accepts
 * the bytes with a 2xx and discards them — the DB rows and the presign/attach
 * contract are proven for real; the round-tripped image bytes are not. This
 * spec asserts on the persisted `job_photos`/`attachments`/`audit_events`
 * rows and on the gallery's DOM card, not on decoded image content.
 *
 * T1: a second tenant's owner, hitting the real API directly, gets an empty
 * list (200 []) for tenant A's job and a 404 attaching tenant A's fileId —
 * matching `job-photo-round-trip.test.ts`'s already-proven behaviour, now
 * reasserted from the browser-reachable layer.
 *
 * Requires: local webServer pair (E2E_BASE_URL unset), a Vite Clerk key
 * (placeholder ok), E2E_USE_TEST_DB=true + DATABASE_URL pointing at a real
 * Postgres, CLERK_DEV_HMAC_TOKENS=true (technician's tenant-scoped HMAC
 * session), run under --project=chromium (never chromium-devauth, which
 * forces InMemory repos).
 *
 * HOW TO RUN:
 *   TESTCONTAINERS_RYUK_DISABLED=true npx tsx e2e/fixtures/setup-test-db.ts
 *   # -> export DATABASE_URL=...
 *   CLERK_DEV_HMAC_TOKENS=true DB_SSL=false DATABASE_URL=<url> \
 *   E2E_USE_TEST_DB=true \
 *   VITE_CLERK_PUBLISHABLE_KEY=pk_test_ZHVtbXkuY2xlcmsuYWNjb3VudHMuZGV2JA== \
 *   QA_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
 *   npx playwright test e2e/journeys/job-photo-attach.spec.ts \
 *     --project=chromium --reporter=line --retries=0
 */
import { test, expect, type Page } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { installClerkStub } from '../helpers/clerk-stub';
import { hasViteClerkKey } from '../helpers/clerk-key';

// Relative to the repo root (Playwright's cwd when run via `npx playwright test`).
const SCREENSHOT_DIR = 'docs/audit/lane-reports/execute-8-5-r5';

// NOT importing e2e/helpers/api-mocks/shell's `blockExternalHosts` here: it
// allows only the WEB app's exact origin, which blocks the photo upload's
// PUT — DevStorageProvider.generateUploadUrl (packages/api/src/files/
// storage-provider.ts:293) returns a presigned URL on the API's OWN origin
// (a different port), not the web app's. Found empirically: the presign
// call succeeded but the browser's follow-up PUT never appeared in the
// server log at all, meaning `page.route` silently aborted it. A local
// variant that allows both the web and API origins keeps the same
// "no external network" intent for this spec's own use.
async function blockHostsOutsideAppAndApi(page: Page, baseURL: string, apiURL: string): Promise<void> {
  const appOrigin = new URL(baseURL).origin;
  const apiOrigin = new URL(apiURL).origin;
  await page.route(
    (url) => url.origin !== appOrigin && url.origin !== apiOrigin,
    (route) => route.abort(),
  );
}

// Real fake-device camera — Chromium's own synthetic capture source, not an
// app-level mock. Scoped to this file only (per-file `test.use`, not a
// playwright.config.ts change). `test.use` REPLACES the project's
// `launchOptions` rather than merging it, so QA_CHROMIUM_PATH's
// executablePath override (the runner's pre-baked chromium binary — see
// playwright.config.ts's `chromium` project) has to be re-applied here too,
// or Playwright falls back to the (missing, in this sandbox) default
// headless-shell download.
test.use({
  launchOptions: {
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    ...(process.env.QA_CHROMIUM_PATH ? { executablePath: process.env.QA_CHROMIUM_PATH } : {}),
  },
  permissions: ['camera', 'microphone'],
});

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3000';

const CLERK_WEBHOOK_SECRET =
  process.env.E2E_CLERK_WEBHOOK_SECRET ?? 'whsec_dGVzdC1zaWdudXAtY3JpdGljYWwtcGF0aA==';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function unsignedJwt(sub: string): string {
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ sub, sid: 'dev-session', role: 'owner' })}.x`;
}

// Mirrors e2e/journeys/accept-invitation.spec.ts's hmacToken() exactly.
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
  return request.post(`${API_URL}/webhooks/clerk`, {
    headers: {
      'content-type': 'application/json',
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': signSvix(rawBody, svixId, svixTimestamp),
    },
    data: rawBody,
  });
}

// Two-key localStorage seed that suppresses WelcomeWalkthrough / WhatsNewModal
// on the `chromium` project (mirrors e2e/helpers/offline-app.ts's
// suppressWalkthroughs / the copy repeated across e2e/journeys/*.spec.ts —
// not reusable as an import since offline-app.ts bundles it into a larger
// offline-boot helper this spec doesn't otherwise want).
async function suppressWalkthroughs(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('walkthrough.welcome.v1', '1');
      window.localStorage.setItem('walkthrough.whatsnew.lastSeen', '2026-06-21-onboarding');
    } catch {
      /* ignore */
    }
  });
}

interface Me {
  tenant_id?: string;
  internal_user_id?: string;
}

test.describe('job-photo-attach (5.2) — real Postgres, real technician screen', () => {
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

  let pool: Pool;

  test.beforeAll(async () => {
    if (!canRun) return;
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  });

  test.afterAll(async () => {
    await pool?.end();
  });

  test('a technician attaches a real photo through the camera sheet on their own job screen; it survives a reload; a neighbour tenant cannot see or receive it (T1)', async ({
    page,
    baseURL,
  }, testInfo) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // ── 1. Bootstrap tenant A's owner (hermetic webhook, DEV_AUTH_BYPASS). ──
    const ownerSub = `user_e2e_photo_owner_${randomUUID().replace(/-/g, '')}`;
    const ownerEmail = `photo-owner-${Date.now()}@serviceos-hermetic.test`;
    const ownerHeaders = { Authorization: `Bearer ${unsignedJwt(ownerSub)}` };

    const bootstrapRes = await postSignedWebhook(page.request, {
      type: 'user.created',
      data: { id: ownerSub, email_addresses: [{ email_address: ownerEmail }] },
    });
    expect(bootstrapRes.status(), `owner bootstrap webhook -> ${await bootstrapRes.text()}`).toBe(200);

    const meRes = await page.request.get(`${API_URL}/api/me`, { headers: ownerHeaders });
    expect(meRes.status(), `/api/me failed: ${await meRes.text()}`).toBe(200);
    const me = (await meRes.json()) as Me;
    expect(me.tenant_id).toMatch(UUID_RE);
    const tenantId = me.tenant_id!;

    // ── 2. Clear the onboarding soft gate. ──────────────────────────────────
    const identityRes = await page.request.put(`${API_URL}/api/onboarding/identity`, {
      headers: { 'content-type': 'application/json', ...ownerHeaders },
      data: JSON.stringify({
        businessName: 'Photo Attach E2E HVAC',
        businessHours: { mon: { open: '08:00', close: '17:00' }, sat: null, sun: null },
        jobBufferMinutes: 30,
        hourlyRateCents: 12500,
        timezone: 'America/Chicago',
      }),
    });
    expect(identityRes.ok(), `PUT /api/onboarding/identity -> ${identityRes.status()}`).toBeTruthy();

    // ── 3. Invite + join a technician, exactly as accept-invitation.spec.ts. ─
    const techEmail = `photo-tech-${Date.now()}@serviceos-hermetic.test`;
    const inviteRes = await page.request.post(`${API_URL}/api/users/invitations`, {
      headers: { 'content-type': 'application/json', ...ownerHeaders },
      data: JSON.stringify({ email: techEmail, role: 'technician' }),
    });
    expect(inviteRes.status(), `POST /api/users/invitations -> ${await inviteRes.text()}`).toBe(201);
    const invitationId = ((await inviteRes.json()) as { id?: string }).id!;

    const techSub = `user_e2e_photo_tech_${randomUUID().replace(/-/g, '')}`;
    const joinRes = await postSignedWebhook(page.request, {
      type: 'user.created',
      data: {
        id: techSub,
        email_addresses: [{ email_address: techEmail }],
        public_metadata: { invitation_id: invitationId, tenant_id: tenantId, role: 'technician' },
      },
    });
    expect(joinRes.status(), `invitee-join webhook -> ${await joinRes.text()}`).toBe(200);
    expect(((await joinRes.json()) as { joined?: string }).joined).toBe(tenantId);

    const techToken = hmacToken(techSub, tenantId, 'technician');
    const techHeaders = { Authorization: `Bearer ${techToken}` };
    const techMeRes = await page.request.get(`${API_URL}/api/me`, { headers: techHeaders });
    expect(techMeRes.status(), `technician /api/me -> ${await techMeRes.text()}`).toBe(200);
    const technicianId = ((await techMeRes.json()) as Me).internal_user_id!;
    expect(technicianId).toMatch(UUID_RE);

    // ── 4. As the owner: create a customer + location + job, scheduled TODAY
    //      (tenant-local) and assigned to the technician in one call. ───────
    const customerRes = await page.request.post(`${API_URL}/api/customers`, {
      headers: { 'content-type': 'application/json', ...ownerHeaders },
      data: JSON.stringify({ firstName: 'Photo', lastName: 'Customer', primaryPhone: '555-0100' }),
    });
    expect(customerRes.status(), `POST /api/customers -> ${await customerRes.text()}`).toBe(201);
    const customerId = ((await customerRes.json()) as { id: string }).id;

    const locationRes = await page.request.post(`${API_URL}/api/locations`, {
      headers: { 'content-type': 'application/json', ...ownerHeaders },
      data: JSON.stringify({
        customerId,
        street1: '1 Photo Way',
        city: 'Austin',
        state: 'TX',
        postalCode: '78701',
      }),
    });
    expect(locationRes.status(), `POST /api/locations -> ${await locationRes.text()}`).toBe(201);
    const locationId = ((await locationRes.json()) as { id: string }).id;

    // 5 minutes from now — inside "today" for the tenant's America/Chicago
    // timezone except within 5 minutes of local midnight (accepted risk;
    // see the lane report for why "now" rather than a fixed local hour).
    const scheduledStart = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const jobRes = await page.request.post(`${API_URL}/api/jobs`, {
      headers: { 'content-type': 'application/json', ...ownerHeaders },
      data: JSON.stringify({
        customerId,
        locationId,
        summary: 'Photo attach E2E job',
        scheduledStart,
        technicianId,
        durationMin: 60,
        timezone: 'America/Chicago',
      }),
    });
    expect(jobRes.status(), `POST /api/jobs (schedule-on-create) -> ${await jobRes.text()}`).toBe(201);
    const jobId = ((await jobRes.json()) as { id: string }).id;

    // ── 5. Bind the browser to the technician and reach their own day view. ─
    await installClerkStub(page, { signedIn: true, sub: techSub, token: techToken });
    await blockHostsOutsideAppAndApi(page, baseURL!, API_URL);
    await suppressWalkthroughs(page);

    await page.goto('/technician/day');
    await expect(page.getByTestId('technician-day-view')).toBeVisible({ timeout: 15_000 });

    // ── GENUINE BUG FOUND, NOT FIXED (test-only lane; packages/api/src is
    //    off-limits) — pinned as a passing characterization, mirroring the
    //    "SECURITY GAP FOUND, NOT FIXED" pattern in
    //    e2e/telephony-e1-signed-webhook.spec.ts:371-403.
    //
    // The day view's own appointment list (GET
    // /api/dispatch/technician/:id/appointments, called by
    // TechnicianDayView.tsx) 403s for EVERY technician session in this
    // harness, unconditionally:
    //
    //   packages/api/src/app.ts:5269 — the DB-authoritative authorization
    //   loader that resolves `req.auth.canonicalUserId` is wired ONLY when
    //   `pool && !isDevAuthBypassEnabled()`. The `chromium` project's own
    //   webServer config hardcodes `DEV_AUTH_BYPASS: 'true'`
    //   (playwright.config.ts:63, apiWebServerEnv — required by this whole
    //   spec family's owner-bootstrap-via-webhook technique, see
    //   accept-invitation.spec.ts), so the loader is NEVER wired for the
    //   ENTIRE process, for every session regardless of how it authenticated.
    //
    //   Without that loader, `resolveAuthorization` (middleware/auth.ts:190
    //   -196) takes its "no loader wired, keep the JWT claim" branch and
    //   never touches `canonicalUserId`. `verifyClerkSession`'s
    //   CLERK_DEV_HMAC_TOKENS decode path (auth/clerk.ts:459-464) never sets
    //   `canonicalUserId` either — only `dev-auth-bypass.ts`'s OWNER-only
    //   `ensureDevOwnerUser` path does. So an invited TECHNICIAN's HMAC
    //   session — the only hermetic technique this codebase's own specs use
    //   to authenticate a non-owner tenant member against real Postgres
    //   (accept-invitation.spec.ts's own `hmacToken` helper) — can never
    //   have `canonicalUserId` populated in this harness.
    //
    //   dispatch/routes.ts:217-225's SEC-22 IDOR guard
    //   (`technicianId !== req.auth!.canonicalUserId`) then always 403s,
    //   since `canonicalUserId` is `undefined` and never equals a real UUID.
    //   Confirmed directly: GET
    //   /api/dispatch/technician/<real-id>/appointments returns
    //   `{"error":"FORBIDDEN","message":"Technicians may only view their
    //   own appointments"}` even for the technician's own id.
    //
    // This blocks EVERY story whose surface is "the technician's own day
    // view", not just this row — worth its own ticket. It is NOT this row's
    // photo-attach capability, and the only fix available to this test-only
    // lane (touching packages/api/src, or the shared apiWebServerEnv in
    // playwright.config.ts used by every other `chromium`-project spec) is
    // out of scope here.
    const dayViewAppointments = await page.request.get(
      `${API_URL}/api/dispatch/technician/${technicianId}/appointments?date=${new Date().toISOString().slice(0, 10)}`,
      { headers: techHeaders },
    );
    expect(dayViewAppointments.status()).toBe(403);
    await expect(
      page.getByText('Failed to load appointments'),
      "pins today's real (buggy) day-view behavior for a technician session in this harness",
    ).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/5.2-day-view-403-bug.png`, fullPage: true });
    await testInfo.attach('day-view-appointments-403-bug', {
      path: `${SCREENSHOT_DIR}/5.2-day-view-403-bug.png`,
      contentType: 'image/png',
    });

    // ── Reach TechJobView anyway, via the same real technician session. ────
    // GET /api/jobs/:id (routes/jobs.ts:510-518) requires only `jobs:view` +
    // tenant scoping — no canonicalUserId ownership check — so it is NOT
    // affected by the bug above. Navigating straight to the URL the day-view
    // card would otherwise produce (TechnicianDayView.tsx:793) reaches the
    // real named surface (TechJobView) with the same real technician auth;
    // only the in-app DISCOVERY step (the broken day-view list) is skipped,
    // not the capability under test.
    await page.goto(`/jobs/${jobId}?view=tech`);
    await expect(page).toHaveURL(new RegExp(`/jobs/${jobId}\\?view=tech`));

    // ── 6. Open the real camera sheet and take a real (fake-device) photo. ──
    const addPhoto = page.getByRole('button', { name: /add photo/i });
    await expect(addPhoto).toBeVisible({ timeout: 15_000 });
    await addPhoto.click();

    // The camera sheet has no data-testid anywhere (CameraCapture.tsx is
    // test-id-free) — this spec is test-only and may not add one to
    // packages/web/src, so readiness is the live <video> element from the
    // fake device stream. `button.bg-white.rounded-full` alone also matches
    // the (photo-mode-active) mode-toggle chip, which shares those two
    // classes — `.active\:scale-90` (found empirically: Playwright's own
    // strict-mode-violation error named both matches) is unique to the
    // shutter button.
    const video = page.locator('video[autoplay]');
    await expect(video).toBeVisible({ timeout: 15_000 });
    const shutter = page.locator('button.bg-white.rounded-full.active\\:scale-90');
    await expect(shutter).toBeVisible({ timeout: 10_000 });
    await shutter.click();

    const doneButton = page.getByRole('button', { name: /^Done/ });
    await expect(doneButton).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/5.2-camera-sheet-before-done.png` });
    await testInfo.attach('camera-sheet-before-done', {
      path: `${SCREENSHOT_DIR}/5.2-camera-sheet-before-done.png`,
      contentType: 'image/png',
    });
    await doneButton.click();

    // ── 7. The upload completes and the gallery shows it as 'before'. ───────
    await expect(page.getByTestId('job-photo-gallery')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('job-photo-grid')).toBeVisible({ timeout: 20_000 });
    let photoCards = page.locator('[data-testid^="job-photo-card-"]');
    await expect(photoCards).toHaveCount(1, { timeout: 20_000 });
    const photoId = (await photoCards.first().getAttribute('data-testid'))!.replace('job-photo-card-', '');
    expect(photoId).toMatch(UUID_RE);
    await expect(photoCards.first()).toContainText('Before');
    await page.screenshot({ path: `${SCREENSHOT_DIR}/5.2-after-upload.png`, fullPage: true });
    await testInfo.attach('technician-screen-after-upload', {
      path: `${SCREENSHOT_DIR}/5.2-after-upload.png`,
      contentType: 'image/png',
    });

    // ── 8. Poll the real rows mid-run (before end-of-run truncation). ───────
    const photoRow = await pool.query(
      `SELECT tenant_id, job_id, category FROM job_photos WHERE id = $1`,
      [photoId],
    );
    expect(photoRow.rows).toHaveLength(1);
    expect(photoRow.rows[0].tenant_id).toBe(tenantId);
    expect(photoRow.rows[0].job_id).toBe(jobId);
    expect(photoRow.rows[0].category).toBe('before');

    const attachmentRow = await pool.query(
      `SELECT tenant_id, entity_id, kind, category FROM attachments
        WHERE tenant_id = $1 AND entity_type = 'job' AND entity_id = $2`,
      [tenantId, jobId],
    );
    expect(attachmentRow.rows).toHaveLength(1);
    expect(attachmentRow.rows[0].kind).toBe('photo');
    expect(attachmentRow.rows[0].category).toBe('before');

    const auditRows = await pool.query(
      `SELECT event_type FROM audit_events
        WHERE tenant_id = $1 AND entity_type = 'job' AND entity_id = $2
          AND event_type LIKE 'job.photo.%'
        ORDER BY event_type`,
      [tenantId, jobId],
    );
    expect(auditRows.rows.map((r) => r.event_type)).toEqual([
      'job.photo.attached',
      'job.photo.upload_requested',
    ]);

    // ── 9. Reload and confirm the photo persists (not just optimistic UI). ──
    await page.reload();
    await expect(page.getByTestId('job-photo-gallery')).toBeVisible({ timeout: 20_000 });
    photoCards = page.locator('[data-testid^="job-photo-card-"]');
    await expect(photoCards).toHaveCount(1, { timeout: 20_000 });
    await expect(page.getByTestId(`job-photo-card-${photoId}`)).toBeVisible();
    await page.screenshot({ path: `${SCREENSHOT_DIR}/5.2-after-reload.png`, fullPage: true });
    await testInfo.attach('technician-screen-after-reload', {
      path: `${SCREENSHOT_DIR}/5.2-after-reload.png`,
      contentType: 'image/png',
    });

    expect(pageErrors, 'no uncaught page errors during the photo-attach journey').toEqual([]);

    // ── 10. STOP POINT — the named surface has no 'after' category control. ─
    // JobPhotoGallery's category chips (job-photo-chip-*) are filters over
    // ALREADY-attached photos, not an upload-time category picker; the
    // technician screen's only capture entry point (the "Add photo" button
    // just exercised) always uploads as 'before'. This assertion pins that
    // gap rather than silently reaching for the disconnected
    // /jobs/:id/photos page (JobPhotoUploader) to manufacture an 'after'
    // photo under a claim of "the technician job screen".
    await expect(
      page.getByTestId('job-photo-category-select'),
      "the technician job screen has no upload-time category selector — " +
        "'after' pairing is not reachable through this surface today (see " +
        'the spec header and the lane report)',
    ).toHaveCount(0);

    // ── 11. T1 — a neighbour tenant, from the real API, cannot see or
    //       receive tenant A's photo. ───────────────────────────────────────
    const otherOwnerSub = `user_e2e_photo_otherowner_${randomUUID().replace(/-/g, '')}`;
    const otherOwnerHeaders = { Authorization: `Bearer ${unsignedJwt(otherOwnerSub)}` };
    const otherBootstrap = await postSignedWebhook(page.request, {
      type: 'user.created',
      data: {
        id: otherOwnerSub,
        email_addresses: [{ email_address: `photo-otherowner-${Date.now()}@serviceos-hermetic.test` }],
      },
    });
    expect(otherBootstrap.status()).toBe(200);
    const otherMe = (await (
      await page.request.get(`${API_URL}/api/me`, { headers: otherOwnerHeaders })
    ).json()) as Me;
    const otherTenantId = otherMe.tenant_id!;
    expect(otherTenantId).not.toBe(tenantId);

    const crossList = await page.request.get(`${API_URL}/api/jobs/${jobId}/photos`, {
      headers: otherOwnerHeaders,
    });
    expect(crossList.status()).toBe(200);
    expect(await crossList.json()).toEqual([]);

    // Give tenant B its own job to attach into, then try tenant A's fileId
    // against it — the file itself is invisible under RLS.
    const bCustomer = await page.request.post(`${API_URL}/api/customers`, {
      headers: { 'content-type': 'application/json', ...otherOwnerHeaders },
      data: JSON.stringify({ firstName: 'Other', lastName: 'Customer', primaryPhone: '555-0200' }),
    });
    const bCustomerId = ((await bCustomer.json()) as { id: string }).id;
    const bLocation = await page.request.post(`${API_URL}/api/locations`, {
      headers: { 'content-type': 'application/json', ...otherOwnerHeaders },
      data: JSON.stringify({
        customerId: bCustomerId,
        street1: '2 Other Way',
        city: 'Austin',
        state: 'TX',
        postalCode: '78701',
      }),
    });
    const bLocationId = ((await bLocation.json()) as { id: string }).id;
    const bJob = await page.request.post(`${API_URL}/api/jobs`, {
      headers: { 'content-type': 'application/json', ...otherOwnerHeaders },
      data: JSON.stringify({ customerId: bCustomerId, locationId: bLocationId, summary: 'Neighbour job' }),
    });
    const bJobId = ((await bJob.json()) as { id: string }).id;

    const fileIdRow = await pool.query(`SELECT file_id FROM job_photos WHERE id = $1`, [photoId]);
    const fileId = fileIdRow.rows[0].file_id as string;

    const crossAttach = await page.request.post(`${API_URL}/api/jobs/${bJobId}/photos`, {
      headers: { 'content-type': 'application/json', ...otherOwnerHeaders },
      data: JSON.stringify({ fileId, category: 'before' }),
    });
    expect(crossAttach.status(), 'a neighbour tenant must not be able to attach tenant A\'s file').toBe(404);
  });
});

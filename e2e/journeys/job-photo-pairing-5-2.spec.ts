import { test, expect, request as pwRequest, type APIRequestContext, type Page } from '@playwright/test';
import { Pool } from 'pg';
import { hasViteClerkKey } from '../helpers/clerk-key';
import { installClerkStub } from '../helpers/clerk-stub';
import {
  bootstrapOwner,
  inviteTechnician,
  postJson,
  tenantWallClockToUtc,
  todayInTz,
  type RealOwner,
  type RealTechnician,
} from '../helpers/real-stack-tenant';

/**
 * §8.5 row 5.2 (#1018) — "As M, I want before/after photos attached to the
 * job, so I can defend the invoice": a captured photo's category AND its
 * before/after pairing survive the round trip — reached by Carlos, in a real
 * browser, at real Postgres.
 *
 * `e2e/journeys/job-photo-attach.spec.ts` reached the attach half and
 * stopped at the pairing clause: the technician screen hardcoded every
 * capture as 'before' and nothing on it led to a pairing control (#1122).
 * #1362 closed both: `TechJobView` now defaults the capture category from
 * the job's status (scheduled → before, started → after) and links to the
 * full gallery (`/jobs/:id/photos`), whose cards carry a "Pair with…"
 * control that calls `POST /api/attachments/:id/pair`.
 *
 * The journey: Carlos opens his own day view, taps View job, captures a
 * photo with the real camera sheet (Chromium's fake device) while the job
 * is still scheduled → 'before'; taps "I've Arrived" (the real job
 * transition to in_progress) and captures again → 'after'; opens the full
 * gallery and pairs the two. Rows polled mid-run: two `job_photos` rows with
 * their categories, the two shadow `attachments` rows sharing one
 * `pair_group_id` with roles before/after, exactly one `attachment.paired`
 * audit event; the pairing survives a reload (read back through the real
 * attachments API). T1: a neighbour tenant's owner cannot list the photos
 * or pair against tenant A's attachment.
 *
 * T2 (a neighbour working in the same run): the neighbour has its own job
 * and, before Carlos starts, captures its OWN before/after photos and pairs
 * them through the same real routes; it also tries to attach a photo to
 * tenant A's job id. None of it changes A's answer: A's job carries exactly
 * Carlos's two photos (counted across ALL tenants — no neighbour row ever
 * lands on A's job), the gallery offers only A's own photo as a pair
 * candidate, and A's pairing leaves the neighbour's pair group, roles and
 * single `attachment.paired` audit exactly as they were. Proven red against
 * a planted fault: the job-ownership lookup (`PgJobRepository.findById`)
 * without its tenant predicate lets the neighbour's photo land on A's job.
 *
 * Runs on `chromium-noauthbypass` (NO_AUTH_BYPASS_SPECS): the technician's
 * own day view needs the DB-authoritative authorization loader (#1086).
 */

const API_URL = process.env.E2E_NOAUTHBYPASS_API_URL ?? 'http://localhost:3002';
const TZ = 'America/Chicago';
const SHOTS = 'docs/audit/lane-reports/1015-1018-rows-rung5';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test.use({
  launchOptions: {
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    ...(process.env.QA_CHROMIUM_PATH ? { executablePath: process.env.QA_CHROMIUM_PATH } : {}),
  },
  permissions: ['camera', 'microphone'],
});

/** The dev storage provider presigns on the API's own origin, so allow both. */
async function allowOnlyAppAndApi(page: Page, baseURL: string): Promise<void> {
  const app = new URL(baseURL).origin;
  const api = new URL(API_URL).origin;
  await page.route((url) => url.origin !== app && url.origin !== api, (route) => route.abort());
}

async function captureWithCameraSheet(page: Page): Promise<void> {
  await page.getByRole('button', { name: /add photo/i }).click();
  await expect(page.locator('video[autoplay]')).toBeVisible({ timeout: 15_000 });
  // The shutter is the only white round button with the press-scale class
  // (CameraCapture.tsx carries no test ids).
  const shutter = page.locator('button.bg-white.rounded-full.active\\:scale-90');
  await expect(shutter).toBeVisible({ timeout: 10_000 });
  await shutter.click();
  const done = page.getByRole('button', { name: /^Done/ });
  await expect(done).toBeVisible({ timeout: 10_000 });
  await done.click();
}

test.describe('5.2 — before/after photos: category and pairing survive the round trip (real Postgres)', () => {
  const canRun = !process.env.E2E_BASE_URL && hasViteClerkKey() && process.env.E2E_USE_TEST_DB === 'true' && !!process.env.DATABASE_URL;
  test.skip(!canRun, 'Needs the local webServer pairs against a real Postgres (E2E_USE_TEST_DB=true, DATABASE_URL).');

  let api: APIRequestContext;
  let pool: Pool;
  let owner: RealOwner;
  let carlos: RealTechnician;
  let neighbour: RealOwner;
  let jobId: string;
  let neighbourJobId: string;

  test.beforeAll(async () => {
    test.setTimeout(180_000); // seeding through the real API is slow under load
    if (!canRun) return;
    api = await pwRequest.newContext({ timeout: 60_000 });
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    owner = await bootstrapOwner(api, API_URL, pool, 'photos', TZ);
    carlos = await inviteTechnician(api, API_URL, owner, 'carlos-photos');
    neighbour = await bootstrapOwner(api, API_URL, pool, 'photos-neighbour', TZ);
    const customer = await postJson(api, `${API_URL}/api/customers`, owner.headers, {
      firstName: 'Pairing',
      lastName: `Customer ${Date.now()}`,
      primaryPhone: '512-555-0152',
    });
    const location = await postJson(api, `${API_URL}/api/locations`, owner.headers, {
      customerId: customer.id,
      street1: '52 Before After Ln',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      isPrimary: true,
    });
    const job = await postJson(api, `${API_URL}/api/jobs`, owner.headers, {
      customerId: customer.id,
      locationId: location.id,
      summary: 'Water heater swap',
      priority: 'normal',
      scheduledStart: tenantWallClockToUtc(todayInTz(TZ), '15:00', TZ).toISOString(),
      durationMin: 60,
      timezone: TZ,
      technicianId: carlos.techId,
    });
    jobId = job.id;

    // T2 — the neighbour's own job, created through the real API.
    const nbCustomer = await postJson(api, `${API_URL}/api/customers`, neighbour.headers, {
      firstName: 'Neighbour',
      lastName: `Photos ${Date.now()}`,
      primaryPhone: '512-555-0153',
    });
    const nbLocation = await postJson(api, `${API_URL}/api/locations`, neighbour.headers, {
      customerId: nbCustomer.id,
      street1: '53 Neighbour Ln',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      isPrimary: true,
    });
    const nbJob = await postJson(api, `${API_URL}/api/jobs`, neighbour.headers, {
      customerId: nbCustomer.id,
      locationId: nbLocation.id,
      summary: 'Neighbour water heater swap',
      priority: 'normal',
    });
    neighbourJobId = nbJob.id;
  });

  /** Presign + attach one photo through the real job-photo routes; returns the HTTP statuses and photo. */
  async function attachViaApi(
    headers: Record<string, string>,
    targetJobId: string,
    category: 'before' | 'after',
  ): Promise<{ presign: number; attach: number | null; photoId?: string }> {
    const presign = await api.post(`${API_URL}/api/jobs/${targetJobId}/photos/presign-upload`, {
      headers: { 'content-type': 'application/json', ...headers },
      data: JSON.stringify({ filename: `${category}.jpg`, contentType: 'image/jpeg', sizeBytes: 2048 }),
    });
    if (presign.status() !== 201) return { presign: presign.status(), attach: null };
    const { fileId } = (await presign.json()) as { fileId: string };
    const attach = await api.post(`${API_URL}/api/jobs/${targetJobId}/photos`, {
      headers: { 'content-type': 'application/json', ...headers },
      data: JSON.stringify({ fileId, category }),
    });
    const body = attach.ok() ? ((await attach.json()) as { id: string }) : undefined;
    return { presign: presign.status(), attach: attach.status(), photoId: body?.id };
  }

  async function neighbourAttachments() {
    return (
      await pool.query<{ id: string; category: string; pair_group_id: string | null; pair_role: string | null }>(
        `SELECT id, category, pair_group_id, pair_role FROM attachments
          WHERE tenant_id = $1 AND entity_type = 'job' AND entity_id = $2 ORDER BY category`,
        [neighbour.tenantId, neighbourJobId],
      )
    ).rows;
  }

  test.afterAll(async () => {
    await api?.dispose();
    await pool?.end();
  });

  test('Carlos captures a before and an after photo on his job, pairs them in the gallery, and the pair survives a reload; a neighbour pairing its own photos in the same run changes none of it (T2)', async ({ page, baseURL }) => {
    test.setTimeout(180_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    await installClerkStub(page, { signedIn: true, sub: carlos.sub, token: carlos.token });
    await page.addInitScript(() => {
      try {
        localStorage.setItem('walkthrough.welcome.v1', '1');
        localStorage.setItem('walkthrough.whatsnew.lastSeen', '2026-06-21-onboarding');
      } catch {
        /* private mode */
      }
    });
    await allowOnlyAppAndApi(page, baseURL!);

    // ── T2 setup: the neighbour's own before/after, paired, BEFORE Carlos
    //    starts — plus an attempt to put a photo on tenant A's job. ────────
    const nbBefore = await attachViaApi(neighbour.headers, neighbourJobId, 'before');
    const nbAfter = await attachViaApi(neighbour.headers, neighbourJobId, 'after');
    expect([nbBefore.attach, nbAfter.attach], 'the neighbour attaches to its own job').toEqual([201, 201]);
    const nbRowsBefore = await neighbourAttachments();
    expect(nbRowsBefore.map((r) => r.category)).toEqual(['after', 'before']);
    const nbBeforeAttachment = nbRowsBefore.find((r) => r.category === 'before')!;
    const nbAfterAttachment = nbRowsBefore.find((r) => r.category === 'after')!;
    const nbPair = await api.post(`${API_URL}/api/attachments/${nbBeforeAttachment.id}/pair`, {
      headers: { 'content-type': 'application/json', ...neighbour.headers },
      data: JSON.stringify({ otherId: nbAfterAttachment.id, role: 'before' }),
    });
    expect(nbPair.status(), `neighbour pairs its own photos -> ${await nbPair.text()}`).toBe(200);
    const nbPaired = await neighbourAttachments();
    expect(nbPaired[0].pair_group_id).toMatch(UUID_RE);
    expect(nbPaired[1].pair_group_id).toBe(nbPaired[0].pair_group_id);
    const intoA = await attachViaApi(neighbour.headers, jobId, 'after');
    expect.soft(intoA, 'the neighbour cannot put a photo on tenant A\'s job').toEqual({ presign: 404, attach: null });

    // ── Carlos's own day → his job screen. ─────────────────────────────────
    await page.goto('/technician/day');
    const viewJob = page.getByTestId('technician-day-appointment').first().getByTestId('technician-day-view-job');
    await expect(viewJob).toBeVisible({ timeout: 15_000 });
    await viewJob.click();
    await expect(page).toHaveURL(new RegExp(`/jobs/${jobId}`), { timeout: 20_000 });

    // ── Before: the job is still scheduled. ────────────────────────────────
    await captureWithCameraSheet(page);
    const cards = page.locator('[data-testid^="job-photo-card-"]');
    await expect(cards).toHaveCount(1, { timeout: 20_000 });
    await expect(cards.first()).toContainText('Before');

    // ── Arrive (real job transition), then After. ─────────────────────────
    const transition = page.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/jobs/${jobId}/transition`,
    );
    // The status CTA renders twice (status card + sticky action bar).
    await page.getByRole('button', { name: /I've Arrived/i }).first().click();
    expect((await transition).status()).toBeLessThan(300);
    await captureWithCameraSheet(page);
    await expect(cards).toHaveCount(2, { timeout: 20_000 });
    await page.screenshot({ path: `${SHOTS}/5.2-tech-job-before-and-after.png`, fullPage: true });

    const { rows: photoRows } = await pool.query<{ id: string; category: string; file_id: string }>(
      `SELECT id, category, file_id FROM job_photos WHERE tenant_id = $1 AND job_id = $2 ORDER BY created_at`,
      [owner.tenantId, jobId],
    );
    expect(photoRows.map((r) => r.category)).toEqual(['before', 'after']);
    const [beforePhoto, afterPhoto] = photoRows;
    // T2 — across ALL tenants, A's job carries exactly Carlos's two photos.
    const { rows: allOnJobA } = await pool.query(`SELECT id FROM job_photos WHERE job_id = $1`, [jobId]);
    expect(allOnJobA, 'no neighbour photo ever lands on tenant A\'s job').toHaveLength(2);

    // ── The full gallery: pair the before photo with the after photo. ──────
    await page.getByRole('link', { name: /open full photo gallery/i }).click();
    await expect(page.getByTestId('job-photos-page')).toBeVisible({ timeout: 15_000 });
    const select = page.getByTestId(`job-photo-pair-select-${beforePhoto.id}`);
    await expect(select).toBeVisible({ timeout: 15_000 });
    // T2 — the pair candidates are A's own other photo only; the neighbour's
    // two photos are never offered.
    const offered = await select.locator('option').evaluateAll((opts) =>
      opts.map((o) => (o as HTMLOptionElement).value).filter((v) => v !== ''),
    );
    expect(offered).toEqual([afterPhoto.id]);
    await select.selectOption(afterPhoto.id);
    const pairResponse = page.waitForResponse(
      (r) => r.request().method() === 'POST' && /\/api\/attachments\/[^/]+\/pair$/.test(new URL(r.url()).pathname),
    );
    await page.getByTestId(`job-photo-pair-button-${beforePhoto.id}`).click();
    expect((await pairResponse).status()).toBe(200);
    await expect(page.getByTestId('job-photos-error')).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/5.2-gallery-paired.png`, fullPage: true });

    // ── Rows, polled mid-run. ─────────────────────────────────────────────
    const { rows: attachmentRows } = await pool.query<{
      id: string;
      file_id: string;
      category: string;
      pair_group_id: string | null;
      pair_role: string | null;
    }>(
      `SELECT id, file_id, category, pair_group_id, pair_role FROM attachments
        WHERE tenant_id = $1 AND entity_type = 'job' AND entity_id = $2`,
      [owner.tenantId, jobId],
    );
    expect(attachmentRows).toHaveLength(2);
    const byFile = new Map(attachmentRows.map((r) => [r.file_id, r]));
    const beforeAttachment = byFile.get(beforePhoto.file_id)!;
    const afterAttachment = byFile.get(afterPhoto.file_id)!;
    expect(beforeAttachment.category).toBe('before');
    expect(afterAttachment.category).toBe('after');
    expect(beforeAttachment.pair_group_id).toMatch(UUID_RE);
    expect(afterAttachment.pair_group_id).toBe(beforeAttachment.pair_group_id);
    expect(beforeAttachment.pair_role).toBe('before');
    expect(afterAttachment.pair_role).toBe('after');
    const { rows: pairedAudits } = await pool.query(
      `SELECT id FROM audit_events WHERE tenant_id = $1 AND event_type = 'attachment.paired' AND entity_id = $2`,
      [owner.tenantId, jobId],
    );
    expect(pairedAudits).toHaveLength(1);
    console.log(
      `[5.2] attachments: ${JSON.stringify(attachmentRows.map(({ category, pair_role, pair_group_id }) => ({ category, pair_role, pair_group_id })))}`,
    );

    // ── Survives a reload: read back through the real attachments API. ────
    await page.reload();
    await expect(page.getByTestId('job-photos-page')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid^="job-photo-card-"]')).toHaveCount(2, { timeout: 15_000 });
    const listed = await api.get(`${API_URL}/api/attachments?entityType=job&entityId=${jobId}`, { headers: carlos.headers });
    expect(listed.status()).toBe(200);
    const listedRows = (await listed.json()) as Array<{ category: string; pairGroupId?: string; pairRole?: string }>;
    expect(listedRows.map((a) => [a.category, a.pairRole]).sort()).toEqual([
      ['after', 'after'],
      ['before', 'before'],
    ]);
    expect(new Set(listedRows.map((a) => a.pairGroupId)).size).toBe(1);

    // ── T1: the neighbour tenant sees nothing and cannot pair A's rows. ───
    const crossPhotos = await api.get(`${API_URL}/api/jobs/${jobId}/photos`, { headers: neighbour.headers });
    expect(crossPhotos.status()).toBe(200);
    expect(await crossPhotos.json()).toEqual([]);
    const crossPair = await api.post(`${API_URL}/api/attachments/${beforeAttachment.id}/pair`, {
      headers: { 'content-type': 'application/json', ...neighbour.headers },
      data: JSON.stringify({ otherId: afterAttachment.id, role: 'before' }),
    });
    expect(crossPair.status(), 'a neighbour must not pair tenant A\'s attachments').toBe(404);
    const { rows: neighbourAudits } = await pool.query<{ entity_id: string }>(
      `SELECT entity_id FROM audit_events WHERE tenant_id = $1 AND event_type = 'attachment.paired'`,
      [neighbour.tenantId],
    );
    // Only the neighbour's own pairing, on its own job — nothing from A's.
    expect(neighbourAudits.map((r) => r.entity_id)).toEqual([neighbourJobId]);

    // ── T2: A's pairing left the neighbour's pair exactly as it was. ──────
    expect(await neighbourAttachments()).toEqual(nbPaired);
    expect(nbPaired[0].pair_group_id).not.toBe(beforeAttachment.pair_group_id);
    const nbListed = await api.get(`${API_URL}/api/jobs/${neighbourJobId}/photos`, { headers: neighbour.headers });
    expect(((await nbListed.json()) as Array<{ category: string }>).map((p) => p.category).sort()).toEqual(['after', 'before']);

    expect(pageErrors, 'no uncaught page errors across the photo journey').toEqual([]);
  });
});

import { test, expect, APIRequestContext } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { installClerkStub } from '../helpers/clerk-stub';
import { blockExternalHosts } from '../helpers/api-mocks/shell';
import { hasViteClerkKey } from '../helpers/clerk-key';
import { PgCatalogItemRepository } from '../../packages/api/src/catalog/pg-catalog-item';
import { PgProposalRepository } from '../../packages/api/src/proposals/pg-proposal';
import { PgCorrectionLessonRepository } from '../../packages/api/src/learning/corrections/pg-correction-lesson';
import { PgAuditRepository } from '../../packages/api/src/audit/pg-audit';
import { buildCorrectionLesson } from '../../packages/api/src/learning/corrections/correction-lesson';
import { detectCorrectionRepetition } from '../../packages/api/src/learning/corrections/correction-repetition';
import type { CatalogItem } from '../../packages/api/src/catalog/catalog-item';

/**
 * §8.9 row 9.10 — rung-5 REACHABILITY for "a mistake corrected three times
 * becomes a permanent fix I approve".
 *
 * `test/integration/correction-repetition-meta-proposal.test.ts` already
 * proves, at real Postgres with T1+T2, that a third same-target correction
 * mints exactly one `update_catalog_item` proposal and that approving it
 * (by directly flipping status + calling the PRODUCTION execution registry)
 * updates the real catalog. What it never does is put that proposal in
 * front of an owner's REAL browser and drive Approve through the actual
 * Inbox click — every approval there is a direct repository/executor call.
 *
 * The three prerequisite corrections are seeded via the same real
 * repository + domain constructor `correction-repetition-meta-proposal.test.ts`
 * uses (`buildCorrectionLesson` / `PgCorrectionLessonRepository`) — no HTTP
 * route exists to mint one directly (see 9.8/9.9's file: the real
 * edit→approve→execute pipeline can never produce a real one today, a
 * separately-reported product gap). This spec picks up exactly where that
 * gap stops: ONCE a meta-proposal exists, is it reachable and approvable by
 * an owner on the real Inbox? Yes — proven here.
 */

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
function signSvix(rawBody: string, svixId: string, svixTimestamp: string): string {
  const secret = Buffer.from(CLERK_WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  const sig = createHmac('sha256', secret).update(`${svixId}.${svixTimestamp}.${rawBody}`).digest('base64');
  return `v1,${sig}`;
}

const WELCOME_SEEN_KEY = 'walkthrough.welcome.v1';
const WHATS_NEW_SEEN_KEY = 'walkthrough.whatsnew.lastSeen';
const SCREENSHOT_DIR = join(process.cwd(), 'docs/audit/lane-reports/8-9-close-r5');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

interface BootstrappedOwner {
  tenantId: string;
  sub: string;
  jwt: string;
  authHeaders: { Authorization: string };
}

async function bootstrapOwner(request: APIRequestContext, label: string): Promise<BootstrappedOwner> {
  const sub = `user_e2e_metaprop_${label}_${randomUUID().replace(/-/g, '')}`;
  const email = `owner-meta-${label}-${Date.now()}@serviceos-hermetic.test`;
  const jwt = unsignedJwt(sub);
  const authHeaders = { Authorization: `Bearer ${jwt}` };

  const svixId = `evt_${randomUUID()}`;
  const svixTimestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = JSON.stringify({ type: 'user.created', data: { id: sub, email_addresses: [{ email_address: email }] } });
  const webhookRes = await request.post(`${API_URL}/webhooks/clerk`, {
    headers: {
      'content-type': 'application/json',
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': signSvix(rawBody, svixId, svixTimestamp),
    },
    data: rawBody,
  });
  expect(webhookRes.status(), `webhook rejected: ${await webhookRes.text()}`).toBe(200);

  const meRes = await request.get(`${API_URL}/api/me`, { headers: authHeaders });
  expect(meRes.status()).toBe(200);
  const me = (await meRes.json()) as { tenant_id?: string };
  expect(me.tenant_id).toMatch(UUID_RE);
  const tenantId = me.tenant_id!;

  const identityRes = await request.put(`${API_URL}/api/onboarding/identity`, {
    headers: { 'content-type': 'application/json', ...authHeaders },
    data: JSON.stringify({
      businessName: `Meta Proposal 9.10 ${label} Co`,
      businessHours: { mon: { open: '08:00', close: '17:00' }, sat: null, sun: null },
      jobBufferMinutes: 30,
      hourlyRateCents: 12500,
      timezone: 'America/Chicago',
    }),
  });
  expect(identityRes.ok(), `PUT /api/onboarding/identity -> ${identityRes.status()}`).toBeTruthy();

  return { tenantId, sub, jwt, authHeaders };
}

test.describe('9.10 reachability — three-strike meta-proposal, approved by the owner on the real Inbox', () => {
  const canRun =
    !process.env.E2E_BASE_URL &&
    hasViteClerkKey() &&
    process.env.E2E_USE_TEST_DB === 'true' &&
    !!process.env.DATABASE_URL;
  test.skip(
    !canRun,
    'Requires the local webServer pair against a real Postgres: leave E2E_BASE_URL unset, ' +
      'set VITE_CLERK_PUBLISHABLE_KEY (placeholder ok), E2E_USE_TEST_DB=true, and DATABASE_URL ' +
      'pointing at the test container (also used directly here to seed the three corrections).',
  );

  test('a third same-SKU correction mints a meta-proposal the owner approves on the real Inbox, and the catalog updates for real through the production executor', async ({
    page,
    request,
    baseURL,
  }) => {
    test.setTimeout(90_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    const owner = await bootstrapOwner(request, 'owner');

    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const catalogItemId = randomUUID();
    let proposalId: string;
    try {
      const catalogRepo = new PgCatalogItemRepository(pool);
      const lessonRepo = new PgCorrectionLessonRepository(pool);
      const proposalRepo = new PgProposalRepository(pool);
      const auditRepo = new PgAuditRepository(pool);

      const nowIso = new Date().toISOString();
      const item: CatalogItem = {
        id: catalogItemId,
        tenantId: owner.tenantId,
        name: 'Smoke Detector',
        description: '',
        category: 'Materials',
        unit: 'each',
        unitPriceCents: 10000,
        productServiceType: 'product',
        archivedAt: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      await catalogRepo.create(item);

      async function seedLesson(createdAt: Date) {
        const lesson = buildCorrectionLesson({
          id: randomUUID(),
          tenantId: owner.tenantId,
          lessonType: 'part_price_changed',
          sourceProposalId: randomUUID(),
          ownerId: owner.sub,
          summary: 'price change',
          payload: { kind: 'part_price_changed', catalogItemId, beforeCents: 10000, afterCents: 8900 },
          localDate: '2026-06-14',
        });
        await lessonRepo.create({ ...lesson, createdAt });
        return lesson;
      }

      await seedLesson(new Date('2026-06-14T01:00:00Z'));
      await seedLesson(new Date('2026-06-14T02:00:00Z'));
      const third = await seedLesson(new Date('2026-06-14T03:00:00Z'));

      const emitted = await detectCorrectionRepetition(
        { tenantId: owner.tenantId, recordedLessons: [third] },
        { lessonRepo, proposalRepo, catalogRepo, auditRepo },
      );
      expect(emitted).toHaveLength(1);
      expect(emitted[0].proposalType).toBe('update_catalog_item');
      expect(emitted[0].status).toBe('ready_for_review');
      proposalId = emitted[0].id;
    } finally {
      await pool.end().catch(() => undefined);
    }

    // ── The owner reaches it on the REAL Inbox and approves it there. ──────
    await installClerkStub(page, { signedIn: true, sub: owner.sub, token: owner.jwt });
    await page.addInitScript(
      ({ welcomeKey, whatsNewKey }) => {
        try {
          localStorage.setItem(welcomeKey, '1');
          localStorage.setItem(whatsNewKey, '2026-06-21-onboarding');
        } catch {
          /* private mode */
        }
      },
      { welcomeKey: WELCOME_SEEN_KEY, whatsNewKey: WHATS_NEW_SEEN_KEY },
    );
    await blockExternalHosts(page, baseURL!);

    // This Mac runs several concurrent lanes (load average routinely > 10);
    // Vite's dev-server module transform for a route's lazy chunk can
    // occasionally lose the race under that contention ("Failed to fetch
    // dynamically imported module", the SPA's own error boundary) — nothing
    // to do with this row. One reload clears it; assert real content after.
    await page.goto('/inbox');
    const crashed = page.getByText('Something went wrong');
    if (await crashed.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await page.reload();
    }
    await expect(page.getByText(/corrected smoke detector to \$89 3 times/i)).toBeVisible({
      timeout: 15_000,
    });
    await page.screenshot({ path: join(SCREENSHOT_DIR, '9-10-01-meta-proposal-on-inbox.png') });

    const approvePromise = page.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/proposals/${proposalId}/approve`,
    );
    await page.getByRole('button', { name: /^approve$/i }).click();
    const approveRes = await approvePromise;
    expect(approveRes.status(), `POST approve -> ${approveRes.status()}`).toBeLessThan(300);
    await expect(page.getByTestId('inbox-row')).toHaveCount(0);
    await page.screenshot({ path: join(SCREENSHOT_DIR, '9-10-02-approved.png') });

    // ── Real execution via the app's own auto-delivery worker — poll. ──────
    await expect
      .poll(
        async () => {
          const res = await request.get(`${API_URL}/api/proposals/${proposalId}`, { headers: owner.authHeaders });
          if (!res.ok()) return 'error';
          const body = (await res.json()) as { status?: string };
          return body.status;
        },
        { timeout: 30_000, message: 'meta-proposal never reached executed' },
      )
      .toBe('executed');

    // ── The catalog price is durably updated — read back via a fresh pool
    //    (no route lists a single catalog item's live price by id here). ───
    const pool2 = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      const catalogRepo2 = new PgCatalogItemRepository(pool2);
      const auditRepo2 = new PgAuditRepository(pool2);
      const updated = await catalogRepo2.findById(owner.tenantId, catalogItemId);
      expect(updated?.unitPriceCents).toBe(8900);

      const catAudits = await auditRepo2.findByEntity(owner.tenantId, 'catalog_item', catalogItemId);
      expect(catAudits.map((a) => a.eventType)).toContain('catalog_item.updated');
      const propAudits = await auditRepo2.findByEntity(owner.tenantId, 'proposal', proposalId);
      expect(propAudits.map((a) => a.eventType)).toContain('proposal.executed');
    } finally {
      await pool2.end().catch(() => undefined);
    }

    expect(pageErrors, 'no uncaught page errors across the 9.10 flow').toEqual([]);
  });
});

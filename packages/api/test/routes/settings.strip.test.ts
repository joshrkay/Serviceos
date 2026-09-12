/**
 * #1011 (wayfinder map #995) — the silent-200 on `PUT /api/settings`.
 *
 * `updateSettingsSchema` is a plain `z.object(…).superRefine(…)`, so Zod's
 * DEFAULT behaviour is to **strip** unrecognized keys. A tenant who PUTs
 * `{ sendThankYouSms: false }` gets a **200** and keeps texting their
 * customers after every job — the write is silently discarded before it ever
 * reaches `PgSettingsRepository`'s column map (which already maps all five
 * keys: pg-settings.ts:372,374,431,438,439).
 *
 * This file pins both halves of that contract:
 *
 *  1. The five keys #1011 adds MUST round-trip (red before the schema change).
 *  2. Strip semantics are DELIBERATE elsewhere and must stay — `.strict()` is
 *     explicitly NOT the remediation (§12.4c). `voice_approval_pin_hash` is
 *     omitted from `escalationSettings` on purpose so a raw credential hash
 *     can never be injected through the generic PUT; going strict would turn
 *     that designed-silent drop into a 400. The two "permanent guard" tests
 *     below fail loudly if anyone adds `.strict()`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { createSettingsRouter } from '../../src/routes/settings';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import {
  InMemorySettingsRepository,
  createSettings,
  getSettings,
} from '../../src/settings/settings';

const TENANT_ID = 'tenant-strip-1011';

describe('PUT /api/settings — owner-toggle keys reach the write map (#1011)', () => {
  let app: express.Express;
  let settingsRepo: InMemorySettingsRepository;

  beforeEach(async () => {
    app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: 'user-1011',
        sessionId: 'session-1011',
        tenantId: TENANT_ID,
        role: 'owner',
      };
      next();
    });

    settingsRepo = new InMemorySettingsRepository();
    await createSettings({ tenantId: TENANT_ID, businessName: 'Strip Test Co' }, settingsRepo);
    app.use('/api/settings', createSettingsRouter(settingsRepo));
  });

  // ── The five keys (§B of the #1011 design) ───────────────────────────────

  it('sendThankYouSms:false round-trips (stop texting customers after every job)', async () => {
    const res = await request(app).put('/api/settings').send({ sendThankYouSms: false });

    expect(res.status).toBe(200);
    expect(res.body.sendThankYouSms).toBe(false);
    const stored = await getSettings(TENANT_ID, settingsRepo);
    expect(stored?.sendThankYouSms).toBe(false);
  });

  it('sendReviewRequest:false round-trips', async () => {
    const res = await request(app).put('/api/settings').send({ sendReviewRequest: false });

    expect(res.status).toBe(200);
    expect(res.body.sendReviewRequest).toBe(false);
    const stored = await getSettings(TENANT_ID, settingsRepo);
    expect(stored?.sendReviewRequest).toBe(false);
  });

  it('weeklyFeedbackEnabled:false round-trips (row 9.7 — opt out of the weekly email)', async () => {
    const res = await request(app).put('/api/settings').send({ weeklyFeedbackEnabled: false });

    expect(res.status).toBe(200);
    expect(res.body.weeklyFeedbackEnabled).toBe(false);
    const stored = await getSettings(TENANT_ID, settingsRepo);
    expect(stored?.weeklyFeedbackEnabled).toBe(false);
  });

  it('autonomousCloseEnabled:true round-trips (D-019 owner-approval chain membership)', async () => {
    const res = await request(app).put('/api/settings').send({ autonomousCloseEnabled: true });

    expect(res.status).toBe(200);
    expect(res.body.autonomousCloseEnabled).toBe(true);
    const stored = await getSettings(TENANT_ID, settingsRepo);
    expect(stored?.autonomousCloseEnabled).toBe(true);
  });

  it('autonomousCloseMaxCents round-trips and rejects a negative / non-integer cap', async () => {
    const ok = await request(app)
      .put('/api/settings')
      .send({ autonomousCloseEnabled: true, autonomousCloseMaxCents: 250_00 });
    expect(ok.status).toBe(200);
    expect(ok.body.autonomousCloseMaxCents).toBe(25000);

    const negative = await request(app)
      .put('/api/settings')
      .send({ autonomousCloseMaxCents: -1 });
    expect(negative.status).toBe(400);

    const fractional = await request(app)
      .put('/api/settings')
      .send({ autonomousCloseMaxCents: 1.5 });
    expect(fractional.status).toBe(400);
  });

  it('records every one of the five keys in the audit changedKeys', async () => {
    const events: { eventType: string; metadata?: Record<string, unknown> }[] = [];
    const auditApp = express();
    auditApp.use(express.json());
    auditApp.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: 'user-1011',
        sessionId: 'session-1011',
        tenantId: TENANT_ID,
        role: 'owner',
      };
      next();
    });
    auditApp.use(
      '/api/settings',
      createSettingsRouter(settingsRepo, undefined, {
        create: async (e: { eventType: string; metadata?: Record<string, unknown> }) => {
          events.push(e);
          return e as never;
        },
      } as never),
    );

    const res = await request(auditApp).put('/api/settings').send({
      sendThankYouSms: false,
      sendReviewRequest: false,
      weeklyFeedbackEnabled: false,
      autonomousCloseEnabled: true,
      autonomousCloseMaxCents: 50_000,
    });
    expect(res.status).toBe(200);

    const settingsEvent = events.find((e) => e.eventType === 'settings.tenant.updated');
    expect(settingsEvent).toBeDefined();
    expect(settingsEvent!.metadata!.changedKeys).toEqual(
      expect.arrayContaining([
        'sendThankYouSms',
        'sendReviewRequest',
        'weeklyFeedbackEnabled',
        'autonomousCloseEnabled',
        'autonomousCloseMaxCents',
      ]),
    );
  });

  // ── Cross-field refine (D7 / §B) ─────────────────────────────────────────

  it('rejects clearing the cap in the same payload that enables the close lane', async () => {
    const res = await request(app)
      .put('/api/settings')
      .send({ autonomousCloseEnabled: true, autonomousCloseMaxCents: null });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('allows clearing the cap on its own (not enabling in the same payload)', async () => {
    const res = await request(app).put('/api/settings').send({ autonomousCloseMaxCents: null });
    expect(res.status).toBe(200);
  });

  // ── Permanent guards: strip stays deliberate, `.strict()` stays out ──────

  it('PERMANENT GUARD: an unknown key is still stripped with a 200, not a 400', async () => {
    const res = await request(app)
      .put('/api/settings')
      .send({ someUnknownKey: 1, businessName: 'Strip Test Co' });

    expect(res.status).toBe(200);
    expect(res.body.someUnknownKey).toBeUndefined();
  });

  it('PERMANENT GUARD: voice_approval_pin_hash can never be injected via the generic PUT', async () => {
    const res = await request(app)
      .put('/api/settings')
      .send({ escalationSettings: { channel_sms: true, voice_approval_pin_hash: 'injected' } });

    expect(res.status).toBe(200);
    expect(res.body.escalationSettings?.voice_approval_pin_hash).toBeUndefined();
    const stored = await getSettings(TENANT_ID, settingsRepo);
    expect(stored?.escalationSettings?.voice_approval_pin_hash).toBeUndefined();
  });

  // ── The keys #1011 deliberately does NOT add (D8/D9/D10/D11) ─────────────

  it('PERMANENT GUARD: e1ReviewedScript stays out of the generic PUT (D8 — life-safety copy)', async () => {
    const res = await request(app)
      .put('/api/settings')
      .send({ e1ReviewedScript: 'rewritten emergency script' });

    expect(res.status).toBe(200);
    const stored = await getSettings(TENANT_ID, settingsRepo);
    expect(stored?.e1ReviewedScript).toBeUndefined();
  });

  it('PERMANENT GUARD: speed-to-lead, the numbering counters and aiModel stay out (D9/D10/D11)', async () => {
    const res = await request(app).put('/api/settings').send({
      speedToLeadEnabled: true,
      speedToLeadTemplate: 'hi',
      nextEstimateNumber: 9999,
      nextInvoiceNumber: 9999,
      aiModel: 'gpt-4o',
      laborRateCentsPerHour: 1,
    });

    expect(res.status).toBe(200);
    const stored = await getSettings(TENANT_ID, settingsRepo);
    expect(stored?.speedToLeadEnabled).toBeUndefined();
    expect(stored?.speedToLeadTemplate).toBeUndefined();
    expect(stored?.aiModel).toBeUndefined();
    // Seeded by createSettings; the generic PUT must not be able to move them.
    expect(stored?.nextEstimateNumber).not.toBe(9999);
    expect(stored?.nextInvoiceNumber).not.toBe(9999);
  });
});

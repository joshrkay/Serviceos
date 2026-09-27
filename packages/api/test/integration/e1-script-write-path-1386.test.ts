/**
 * #1386 — the owner's write path for the reviewed E1 life-safety script, and
 * the O-2 launch rule it serves. Real Postgres throughout.
 *
 * O-2 (owner, 2026-09-26, docs/audit/blocked-on-josh.md): a licensed trade
 * professional plus counsel sign the E1 script; UNTIL THEN E1 may launch only
 * with the placeholder HARD-FLAGGED. So:
 *   - `PUT /api/settings/e1-script` stores the signed-off script together with
 *     the reviewer attestation (who, in what role, when), owner-only, audited;
 *   - `GET /api/settings/e1-script` tells the owner which script is live (the
 *     web banner reads it);
 *   - `DELETE` reverts to the placeholder, audited.
 *
 * Identity is stubbed the way every settings integration test here stubs it
 * (req.auth set before the real requireAuth/requireTenant/requirePermission
 * chain); everything below that line is production code.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import crypto from 'node:crypto';

import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import type { TestTenant } from './shared';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import { createSettingsRouter } from '../../src/routes/settings';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgUserRepository } from '../../src/users/pg-user';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { createVoiceGate } from '../../src/voice/voice-gate';
import type { AuditEvent } from '../../src/audit/audit';
import type { VoiceSession } from '../../src/ai/agents/customer-calling/types';

type Actor = { tenantId: string; userId: string; role: 'owner' | 'dispatcher' | 'technician' };

const REVIEWED_SCRIPT =
  'If anyone is in danger, hang up and dial 911 now. Get everyone out of the house and wait outside for the gas company.';
const ATTESTATION = {
  reviewedByName: 'Pat Reviewer',
  reviewedByRole: 'Licensed master plumber; reviewed with counsel',
  reviewedAt: '2026-09-20T15:00:00.000Z',
};

describe('Postgres integration — #1386 owner writes the reviewed E1 script', () => {
  let pool: Pool;
  let app: express.Express;
  let auditRepo: PgAuditRepository;
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let current: Actor;

  const as = (actor: Actor) => {
    current = actor;
  };
  const owner = (t: TestTenant): Actor => ({ tenantId: t.tenantId, userId: t.userId, role: 'owner' });

  beforeAll(async () => {
    pool = await getSharedTestDb();
    auditRepo = new PgAuditRepository(pool);
    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);

    app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: current.userId,
        sessionId: 'sess-1386',
        tenantId: current.tenantId,
        role: current.role,
      };
      next();
    });
    app.use(
      '/api/settings',
      createSettingsRouter(new PgSettingsRepository(pool), undefined, auditRepo),
    );
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('an owner saves the reviewed script with its attestation; GET then reports it live, and the write is audited', async () => {
    as(owner(tenantA));
    const before = await request(app).get('/api/settings/e1-script');
    expect(before.status).toBe(200);
    expect(before.body).toEqual({
      status: 'placeholder',
      reviewedScript: null,
      reviewedByName: null,
      reviewedByRole: null,
      reviewedAt: null,
    });

    const put = await request(app)
      .put('/api/settings/e1-script')
      .send({ script: REVIEWED_SCRIPT, ...ATTESTATION });
    expect(put.status).toBe(200);
    const live = {
      status: 'reviewed',
      reviewedScript: REVIEWED_SCRIPT,
      ...ATTESTATION,
    };
    expect(put.body).toEqual(live);

    const after = await request(app).get('/api/settings/e1-script');
    expect(after.body).toEqual(live);

    const rows = await auditRepo.findRecentByTenant(tenantA.tenantId);
    const row = rows.find((e) => e.eventType === 'settings.e1_script.reviewed');
    expect(row).toBeDefined();
    expect(row?.actorId).toBe(tenantA.userId);
    expect(row?.actorRole).toBe('owner');
    expect(row?.metadata).toMatchObject({ ...ATTESTATION, previousStatus: 'placeholder' });

    // T1 — tenant B still runs the placeholder.
    as(owner(tenantB));
    const b = await request(app).get('/api/settings/e1-script');
    expect(b.body.status).toBe('placeholder');
  });

  it('refuses a dispatcher and a technician (403), and a script with no attestation (400) — nothing is saved', async () => {
    const t = await createTestTenant(pool);
    for (const role of ['dispatcher', 'technician'] as const) {
      as({ tenantId: t.tenantId, userId: t.userId, role });
      const res = await request(app)
        .put('/api/settings/e1-script')
        .send({ script: REVIEWED_SCRIPT, ...ATTESTATION });
      expect(res.status, role).toBe(403);
    }

    as(owner(t));
    const noAttestation = await request(app)
      .put('/api/settings/e1-script')
      .send({ script: REVIEWED_SCRIPT });
    expect(noAttestation.status).toBe(400);
    const future = await request(app)
      .put('/api/settings/e1-script')
      .send({ script: REVIEWED_SCRIPT, ...ATTESTATION, reviewedAt: '2999-01-01T00:00:00.000Z' });
    expect(future.status).toBe(400);

    const after = await request(app).get('/api/settings/e1-script');
    expect(after.body.status).toBe('placeholder');
    const rows = await auditRepo.findRecentByTenant(t.tenantId);
    expect(rows.filter((e) => e.eventType.startsWith('settings.e1_script'))).toHaveLength(0);
  });

  it('the owner can revert to the placeholder; the revert is audited', async () => {
    const t = await createTestTenant(pool);
    as(owner(t));
    await request(app).put('/api/settings/e1-script').send({ script: REVIEWED_SCRIPT, ...ATTESTATION });

    const del = await request(app).delete('/api/settings/e1-script');
    expect(del.status).toBe(200);
    expect(del.body).toEqual({
      status: 'placeholder',
      reviewedScript: null,
      reviewedByName: null,
      reviewedByRole: null,
      reviewedAt: null,
    });
    const rows = await auditRepo.findRecentByTenant(t.tenantId);
    const cleared = rows.find((e) => e.eventType === 'settings.e1_script.cleared');
    expect(cleared?.metadata).toMatchObject({ previousStatus: 'reviewed' });
  });

  // ─── The E1 call itself, at the real Gather handler ──────────────────────

  const OWNER_PHONE = '+15125550861';
  const EN_GAS = 'I smell gas in my kitchen and it is getting stronger';
  const ES_GAS = 'hay una fuga de gas en mi casa, huele muy fuerte';
  const ES_911_SAY =
    '<Say voice="Polly.Mia-Neural">Si alguien está en peligro inmediato, cuelgue y llame al 911.</Say>';
  let phoneSeq = 0;

  /** A tenant whose OTHER gates all pass: paid, live, owner phone on file. */
  async function answeringTenant(): Promise<TestTenant> {
    const t = await createTestTenant(pool);
    await pool.query(`UPDATE tenants SET subscription_status = 'active' WHERE id = $1`, [t.tenantId]);
    await pool.query(
      `INSERT INTO tenant_settings (id, tenant_id, business_name, timezone, region, owner_phone, voice_agent_live_at)
       VALUES ($1, $2, 'E1 Flag Shop', 'America/Chicago', 'TX', $3, NOW())`,
      [crypto.randomUUID(), t.tenantId, OWNER_PHONE],
    );
    return t;
  }

  interface Call {
    session: VoiceSession;
    adapter: TwilioGatherAdapter;
    callSid: string;
    tenantId: string;
    sms: ReturnType<typeof vi.fn>;
    llm: ReturnType<typeof vi.fn>;
  }

  async function inboundCall(tenantId: string): Promise<Call> {
    const store = new VoiceSessionStore({ startInterval: false });
    const sms = vi.fn(async () => ({ sid: 'SM-test' }));
    // Scripted for the booking leg only (classify → create_appointment,
    // confirm → yes); rejected before the E1 turn, so no model is on it.
    const llm = vi.fn().mockImplementation(async (req: Record<string, unknown>) => {
      const skill = (req.metadata as Record<string, unknown> | undefined)?.skill;
      return {
        content:
          skill === 'confirm_intent'
            ? JSON.stringify({ answer: 'yes', reasoning: 'clear affirmative' })
            : JSON.stringify({
                intentType: 'create_appointment',
                confidence: 0.95,
                extractedEntities: { dateTimeDescription: 'tomorrow at 9am' },
              }),
        model: 'stub',
        provider: 'stub',
        tokenUsage: { input: 1, output: 1, total: 2 },
        latencyMs: 1,
      };
    });
    const adapter = new TwilioGatherAdapter({
      store,
      gateway: { complete: llm },
      businessName: 'E1 Flag Shop',
      publicBaseUrl: 'https://example.com',
      pool,
      userRepo: new PgUserRepository(pool),
      settingsRepo: new PgSettingsRepository(pool),
      auditRepo,
      proposalRepo: new PgProposalRepository(pool),
      customerRepo: new PgCustomerRepository(pool),
      appointmentRepo: new PgAppointmentRepository(pool),
      jobRepo: new PgJobRepository(pool),
      deliveryProvider: { sendSms: sms },
    } as never);
    const callSid = `CA-1386-${crypto.randomUUID().slice(0, 8)}`;
    phoneSeq += 1;
    const from = `+1512555${String(7000 + phoneSeq).slice(0, 4)}`;
    await adapter.handleInbound({ callSid, from, to: '+15125550000', tenantId });
    const session = store.findByCallSid(callSid)!;
    if (session.machine.currentState === 'greeting') {
      session.machine.dispatch({ type: 'greeted_ok' });
    }
    if (session.machine.currentState === 'ask_caller') {
      await adapter.handleGather({
        sessionId: session.id,
        callSid,
        speechResult: 'Casey Rivera, 12 Oak Street',
        confidence: 0.95,
        tenantId,
      });
    }
    return { session, adapter, callSid, tenantId, sms, llm };
  }

  const turn = (c: Call, speech: string): Promise<string> =>
    c.adapter.handleGather({
      sessionId: c.session.id,
      callSid: c.callSid,
      speechResult: speech,
      confidence: 0.95,
      tenantId: c.tenantId,
    });

  async function e1Row(c: Call): Promise<AuditEvent | undefined> {
    const rows = await auditRepo.findByEntity(c.tenantId, 'voice_session', c.session.id);
    return rows.find((e) => e.eventType.endsWith('.emergency_detected'));
  }

  it('once the owner saves a reviewed script, an E1 call speaks it and the audit row is NOT flagged as the placeholder', async () => {
    const t = await answeringTenant();
    as(owner(t));
    const put = await request(app)
      .put('/api/settings/e1-script')
      .send({ script: REVIEWED_SCRIPT, ...ATTESTATION });
    expect(put.status).toBe(200);

    const c = await inboundCall(t.tenantId);
    const twiml = await turn(c, EN_GAS);

    expect(twiml).toContain('wait outside for the gas company');
    expect(twiml).not.toContain('without using light switches');
    expect((await e1Row(c))?.metadata).toMatchObject({
      tier: 'E1',
      reason: 'life_safety_e1',
      e1ScriptPlaceholder: false,
    });
  });

  // ─── Life-safety proof on the placeholder (O-2: hard-flagged, not voicemail) ─

  async function bookThroughTheCall(c: Call): Promise<string> {
    await turn(c, 'I need an appointment tomorrow at 9am');
    expect(c.session.machine.currentState).toBe('intent_confirm');
    await turn(c, 'yes that is right');
    expect(c.session.proposalIds).toHaveLength(1);
    const id = c.session.proposalIds[0]!;
    expect((await new PgProposalRepository(pool).findById(c.tenantId, id))?.status).toBe('draft');
    return id;
  }

  async function waitFor<T>(read: () => Promise<T>, ok: (v: T) => boolean, label: string): Promise<T> {
    let last = await read();
    for (let i = 0; i < 50 && !ok(last); i += 1) {
      await new Promise((r) => {
        setTimeout(r, 40);
      });
      last = await read();
    }
    if (!ok(last)) throw new Error(`waitFor timed out: ${label}`);
    return last;
  }

  async function expectFullE1OnThePlaceholder(c: Call, twiml: string, bookingId: string) {
    // Terminal life-safety close: 911 + the placeholder evacuation script,
    // then hang up — no further <Gather>, no dispatcher bridge.
    expect(c.session.machine.currentState).toBe('terminated');
    expect(c.session.machine.currentContext.escalationReason).toBe('life_safety_e1');
    expect(twiml).toContain('call 911 now');
    expect(twiml).toContain('please leave the building immediately without using light switches');
    expect(twiml).toContain('<Hangup/>');
    expect(twiml).not.toContain('<Gather');
    expect(twiml).not.toContain('on-call dispatcher');

    // The drafted booking is revoked in Postgres.
    const booking = await waitFor(
      () => new PgProposalRepository(pool).findById(c.tenantId, bookingId),
      (p) => p?.status === 'rejected',
      'booking revoked',
    );
    expect(booking?.rejectionReason).toBe('life_safety_emergency');

    // The tenant is alerted (the owner's phone gets the E1 text).
    await waitFor(async () => c.sms.mock.calls.length, (n) => n > 0, 'tenant alert sent');
    expect(c.sms).toHaveBeenCalledWith(
      expect.objectContaining({ to: OWNER_PHONE, body: expect.stringContaining('EMERGENCY (E1 life-safety)') }),
    );

    // The durable E1 record carries the hard flag.
    expect((await e1Row(c))?.metadata).toMatchObject({
      tier: 'E1',
      reason: 'life_safety_e1',
      e1ScriptPlaceholder: true,
    });
  }

  it('ENGLISH: with NO reviewed script the gate answers (not voicemail) and an E1 call runs the full life-safety path on the hard-flagged placeholder', async () => {
    const t = await answeringTenant();
    const gate = createVoiceGate({ pool, auditRepo });
    expect(await gate({ tenantId: t.tenantId, callSid: 'CA-1386-gate-en' })).toEqual({ allowed: true });

    const c = await inboundCall(t.tenantId);
    const bookingId = await bookThroughTheCall(c);
    c.llm.mockRejectedValue(new Error('LLM gateway is down'));
    const twiml = await turn(c, EN_GAS);

    await expectFullE1OnThePlaceholder(c, twiml, bookingId);
  });

  it('SPANISH: with NO reviewed script, "fuga de gas" gets the Spanish 911 line first, then the placeholder script, and the flag', async () => {
    const t = await answeringTenant();
    const gate = createVoiceGate({ pool, auditRepo });
    expect(await gate({ tenantId: t.tenantId, callSid: 'CA-1386-gate-es' })).toEqual({ allowed: true });

    const c = await inboundCall(t.tenantId);
    const bookingId = await bookThroughTheCall(c);
    c.llm.mockRejectedValue(new Error('LLM gateway is down'));
    const twiml = await turn(c, ES_GAS);

    expect(twiml).toContain(ES_911_SAY);
    expect(twiml.indexOf(ES_911_SAY)).toBeLessThan(twiml.indexOf('call 911 now'));
    expect((await e1Row(c))?.metadata).toMatchObject({ language: 'es' });
    await expectFullE1OnThePlaceholder(c, twiml, bookingId);
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgAuditRepository, VOICE_APPROVAL_PIN_LOCK_EVENTS_SQL } from '../../src/audit/pg-audit';
import { createAuditEvent } from '../../src/audit/audit';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { ensureTenantSettings, DEFAULT_ESCALATION_SETTINGS } from '../../src/settings/settings';
import { hashVoiceApprovalPin } from '../../src/settings/voice-approval-pin';
import { createSettingsRouter } from '../../src/routes/settings';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import {
  startVoiceApproval,
  continueVoiceApproval,
  VOICE_APPROVAL_ACTOR_ID,
  type VoiceApprovalDeps,
  type VoiceApprovalSessionState,
  type VoiceApprovalTurnResult,
} from '../../src/ai/tasks/proposal-approval-task';
import { createProposal, type Proposal, type ProposalType } from '../../src/proposals/proposal';

/**
 * #1051 follow-up at REAL Postgres — the TENANT-WIDE money-approval PIN lock.
 *
 * PR #1217 re-derives the three-strike lock for ONE voice session from its
 * strike rows. A caller could still start another call (a new session id) for
 * fresh guesses. This file proves, against a real PgAuditRepository /
 * PgProposalRepository / PgSettingsRepository under RLS_RUNTIME_ROLE, that:
 *
 *   - 5 strikes for one tenant inside 24h, spread over TWO calls, lock money
 *     approval for a THIRD call before any challenge — the right code included;
 *   - the owner gets exactly ONE alert when it engages, carrying no link, and no
 *     one-tap approval link goes out while the tenant is locked;
 *   - capture-class items still approve;
 *   - T1: a neighbour tenant's strikes — even under the same session ids — never
 *     lock this tenant, and neither tenant's lookup reads the other's rows;
 *   - a PIN change through the real `PUT /api/settings/voice-approval-pin`
 *     resets the count (a weak PIN is refused by that route);
 *   - strikes older than 24h, or from before the PIN change, do not count;
 *   - the strike lookup's SQL is served by migration 279's partial index.
 *
 * The SMS transport is stubbed (an external send); every proposal, settings
 * and audit row here is real Postgres, and the file deliberately leaves its
 * rows in place (tenants are fresh per test) so they can be dumped as evidence.
 */

const PIN_SECRET = 'i3-tenant-pin-lock-secret';
const PIN = '4271';
const NEW_PIN = '5382';
const HOUR = 60 * 60 * 1000;

const STRIKE_FAILED = 'proposal.voice_approval_challenge_failed';
const STRIKE_LOCKOUT = 'proposal.voice_challenge_lockout';
const TENANT_LOCK_ALERTED = 'proposal.voice_approval_tenant_lock_alerted';
const REFUSED = 'proposal.voice_approve_refused_challenge_lockout';

type Sent = { to: string; body: string };

describe('#1051 — tenant-wide money-approval PIN lock at real Postgres', () => {
  let pool: Pool;
  let proposalRepo: PgProposalRepository;
  let auditRepo: PgAuditRepository;
  let settingsRepo: PgSettingsRepository;
  let previousSecret: string | undefined;

  beforeAll(async () => {
    previousSecret = process.env.TENANT_ENCRYPTION_KEY;
    process.env.TENANT_ENCRYPTION_KEY = PIN_SECRET;
    pool = await getSharedTestDb();
    proposalRepo = new PgProposalRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
  });

  afterAll(async () => {
    if (previousSecret === undefined) delete process.env.TENANT_ENCRYPTION_KEY;
    else process.env.TENANT_ENCRYPTION_KEY = previousSecret;
    await closeSharedTestDb();
  });

  function makeDeps(ownerPhone: string): { deps: VoiceApprovalDeps; sent: Sent[] } {
    const sent: Sent[] = [];
    return {
      sent,
      deps: {
        proposalRepo,
        auditRepo,
        settingsRepo,
        smsEventRepo: { hasUnappliedEditRequest: async () => false },
        oneTapFallback: {
          sendSms: async (to, body) => {
            sent.push({ to, body });
          },
          secret: 'i3-tenant-pin-lock-one-tap',
          buildApproveUrl: (token) => `https://x.test/approve?token=${token}`,
          resolveOwnerPhone: async () => ownerPhone,
        },
      },
    };
  }

  /** The REAL settings router, authenticated as the tenant's owner. */
  function settingsApp(tenantId: string, userId: string): express.Express {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = { userId, sessionId: 'i3-pin-web', tenantId, role: 'owner' };
      next();
    });
    app.use('/api/settings', createSettingsRouter(settingsRepo, undefined, auditRepo));
    return app;
  }

  async function freshTenant(): Promise<{ tenantId: string; userId: string }> {
    const tenant = await createTestTenant(pool);
    await ensureTenantSettings(tenant.tenantId, settingsRepo);
    return tenant;
  }

  /** Enroll through the real route (which stamps voice_approval_pin_changed_at). */
  async function enrollViaRoute(tenant: { tenantId: string; userId: string }, pin: string) {
    return request(settingsApp(tenant.tenantId, tenant.userId))
      .put('/api/settings/voice-approval-pin')
      .send({ pin });
  }

  /** Enroll directly with a chosen PIN-change time (for the window tests). */
  async function enrollAt(tenantId: string, pin: string, changedAt: Date | null) {
    const existing = await ensureTenantSettings(tenantId, settingsRepo);
    await settingsRepo.update(tenantId, {
      escalationSettings: {
        ...DEFAULT_ESCALATION_SETTINGS,
        ...existing.escalationSettings,
        voice_approval_pin_hash: hashVoiceApprovalPin(pin, tenantId, PIN_SECRET),
        ...(changedAt ? { voice_approval_pin_changed_at: changedAt.toISOString() } : {}),
      },
    });
  }

  async function seedPending(
    tenantId: string,
    opts: { proposalType: ProposalType; summary: string; payload: Record<string, unknown> },
  ): Promise<Proposal> {
    const proposal = createProposal({ tenantId, createdBy: 'voice', ...opts });
    await proposalRepo.create(proposal);
    await proposalRepo.updateStatus(tenantId, proposal.id, 'ready_for_review');
    return (await proposalRepo.findById(tenantId, proposal.id))!;
  }

  const seedMoney = (tenantId: string, customerName: string, amountCents: number) =>
    seedPending(tenantId, {
      proposalType: 'record_payment',
      summary: `Record $${amountCents / 100} payment from ${customerName}`,
      payload: { customerName, amountCents },
    });

  /** A strike row as an earlier call would have left it, at a chosen time. */
  async function strikeAt(tenantId: string, sessionId: string, at: Date): Promise<void> {
    const event = createAuditEvent({
      tenantId,
      actorId: VOICE_APPROVAL_ACTOR_ID,
      actorRole: 'system',
      eventType: STRIKE_FAILED,
      entityType: 'proposal',
      entityId: sessionId,
      correlationId: sessionId,
      metadata: { channel: 'voice', sessionId, attemptCount: 1, seeded: true },
    });
    event.createdAt = at;
    await auditRepo.create(event);
  }

  /** readback → yes → challenge prompt, then speak each code; returns the outcomes. */
  async function callWithCodes(
    deps: VoiceApprovalDeps,
    ref: { tenantId: string; sessionId: string; ownerSession: true },
    reference: string,
    codes: string[],
  ): Promise<{ outcomes: string[]; last: VoiceApprovalTurnResult }> {
    const start = await startVoiceApproval(deps, { ...ref, action: 'approve', reference });
    if (start.outcome !== 'readback') return { outcomes: [start.outcome], last: start };
    const confirm = await continueVoiceApproval(deps, { ...ref, utterance: 'yes', pending: start.pending! });
    if (confirm.outcome !== 'challenge_prompt') return { outcomes: [confirm.outcome], last: confirm };
    let pending = confirm.pending!;
    let sessionState: VoiceApprovalSessionState = {};
    const outcomes: string[] = [];
    let last = confirm;
    for (const code of codes) {
      last = await continueVoiceApproval(deps, { ...ref, sessionState, utterance: code, pending });
      outcomes.push(last.outcome);
      sessionState = { ...sessionState, ...last.sessionState };
      if (!last.pending) break;
      pending = last.pending;
    }
    return { outcomes, last };
  }

  async function rowsOfType(tenantId: string, eventType: string) {
    const rows = await auditRepo.findVoiceApprovalPinLockEvents(tenantId, new Date(Date.now() - 48 * HOUR));
    return rows.filter((r) => r.eventType === eventType);
  }

  const hasLink = (body: string) => /https?:\/\/|token=/.test(body);

  it('5 strikes over TWO calls lock money approval for a THIRD call — before any challenge, right code included; ONE link-free alert; capture still approves', async () => {
    const tenant = await freshTenant();
    expect((await enrollViaRoute(tenant, PIN)).status).toBe(204);
    const { deps, sent } = makeDeps('+15125550201');
    const acme = await seedMoney(tenant.tenantId, 'Acme Corp', 20000);
    const call = (n: number) => ({ tenantId: tenant.tenantId, sessionId: `i3t-call-${n}`, ownerSession: true }) as const;

    // Call 1 — three wrong codes: the SESSION lock (tenant count 3 < 5), with
    // its existing one-tap link.
    const call1 = await callWithCodes(deps, call(1), 'the Acme payment', ['0 0 0 0', '1 1 1 1', '9 9 9 9']);
    expect(call1.outcomes).toEqual(['challenge_failed', 'challenge_failed', 'challenge_lockout']);
    expect(sent).toHaveLength(1);
    expect(hasLink(sent[0].body)).toBe(true);

    // Call 2 — a NEW session. The 4th strike is allowed; the 5th locks the tenant.
    const call2 = await callWithCodes(deps, call(2), 'the Acme payment', ['0 0 0 0', '2 2 2 2', '3 3 3 3']);
    expect(call2.outcomes).toEqual(['challenge_failed', 'challenge_lockout']);
    expect(call2.last.pending).toBeNull();

    // Exactly one alert, to the owner, with no link.
    expect(sent).toHaveLength(2);
    expect(sent[1].to).toBe('+15125550201');
    expect(hasLink(sent[1].body)).toBe(false);

    // Call 3 — refused at readback: no challenge is ever prompted.
    const refused = await startVoiceApproval(deps, { ...call(3), action: 'approve', reference: 'the Acme payment' });
    expect(refused.outcome).toBe('challenge_lockout');
    expect(refused.pending).toBeNull();
    // Even a challenge turn carrying the RIGHT code approves nothing.
    const rightCode = await continueVoiceApproval(deps, {
      ...call(3),
      utterance: 'four two seven one',
      pending: { action: 'approve', stage: 'challenge', proposalId: acme.id },
    });
    expect(rightCode.outcome).toBe('challenge_lockout');
    expect((await proposalRepo.findById(tenant.tenantId, acme.id))?.status).toBe('ready_for_review');

    // Still locked on a 4th call: no second alert, no approval link.
    await startVoiceApproval(deps, { ...call(4), action: 'approve', reference: 'the Acme payment' });
    expect(sent).toHaveLength(2);

    // Capture-class still approves by voice.
    const capture = await seedPending(tenant.tenantId, {
      proposalType: 'draft_estimate',
      summary: 'Estimate for Henderson — water heater',
      payload: { customerName: 'Henderson', lineItems: [{ description: 'Water heater', total: 45000 }], totalCents: 45000 },
    });
    const capStart = await startVoiceApproval(deps, { ...call(4), action: 'approve', reference: 'the Henderson estimate' });
    expect(capStart.outcome).toBe('readback');
    const capYes = await continueVoiceApproval(deps, { ...call(4), utterance: 'yes', pending: capStart.pending! });
    expect(capYes.outcome).toBe('approved');
    expect((await proposalRepo.findById(tenant.tenantId, capture.id))?.status).toBe('approved');

    // The durable trail, read back through the real lookup.
    const strikes = [
      ...(await rowsOfType(tenant.tenantId, STRIKE_FAILED)),
      ...(await rowsOfType(tenant.tenantId, STRIKE_LOCKOUT)),
    ];
    expect(strikes).toHaveLength(5);
    expect(new Set(strikes.map((r) => r.correlationId))).toEqual(new Set(['i3t-call-1', 'i3t-call-2']));
    expect(strikes.some((r) => r.metadata?.tenantLockEngaged === true && r.metadata?.tenantStrikeCount === 5)).toBe(true);
    expect(await rowsOfType(tenant.tenantId, TENANT_LOCK_ALERTED)).toHaveLength(1);
    const refusals = (await auditRepo.findByEntity(tenant.tenantId, 'proposal', acme.id)).filter(
      (r) => r.eventType === REFUSED,
    );
    expect(refusals.length).toBeGreaterThanOrEqual(3);
    expect(refusals.every((r) => r.metadata?.lockSource === 'tenant_lock')).toBe(true);
  });

  it('T1 — a neighbour tenant locked under the SAME session ids never locks this tenant, and neither lookup reads the other’s rows', async () => {
    const neighbour = await freshTenant();
    const tenant = await freshTenant();
    expect((await enrollViaRoute(neighbour, PIN)).status).toBe(204);
    expect((await enrollViaRoute(tenant, PIN)).status).toBe(204);
    const { deps: nDeps } = makeDeps('+15125550202');
    const { deps, sent } = makeDeps('+15125550203');
    await seedMoney(neighbour.tenantId, 'Acme Corp', 20000);
    const money = await seedMoney(tenant.tenantId, 'Acme Corp', 20000);
    const nCall = (n: number) => ({ tenantId: neighbour.tenantId, sessionId: `i3t-shared-${n}`, ownerSession: true }) as const;
    const tCall = (n: number) => ({ tenantId: tenant.tenantId, sessionId: `i3t-shared-${n}`, ownerSession: true }) as const;

    await callWithCodes(nDeps, nCall(1), 'the Acme payment', ['0000', '1111', '9999']);
    await callWithCodes(nDeps, nCall(2), 'the Acme payment', ['0000', '2222']);
    const neighbourLocked = await startVoiceApproval(nDeps, { ...nCall(3), action: 'approve', reference: 'the Acme payment' });
    expect(neighbourLocked.outcome).toBe('challenge_lockout');

    // This tenant, same session ids: prompted, and the right code approves.
    const ours = await callWithCodes(deps, tCall(3), 'the Acme payment', ['4271']);
    expect(ours.outcomes).toEqual(['approved']);
    expect((await proposalRepo.findById(tenant.tenantId, money.id))?.status).toBe('approved');
    expect(sent).toHaveLength(0);

    const since = new Date(Date.now() - 48 * HOUR);
    const ourRows = await auditRepo.findVoiceApprovalPinLockEvents(tenant.tenantId, since);
    const theirRows = await auditRepo.findVoiceApprovalPinLockEvents(neighbour.tenantId, since);
    expect(ourRows).toHaveLength(0);
    expect(theirRows.length).toBeGreaterThanOrEqual(6); // 5 strikes + the alert
    expect(theirRows.every((r) => r.tenantId === neighbour.tenantId)).toBe(true);
  });

  it('a PIN change through the real PUT /api/settings/voice-approval-pin resets the count — a weak PIN is refused there — and the locked tenant approves with the new PIN', async () => {
    const tenant = await freshTenant();
    await enrollAt(tenant.tenantId, PIN, new Date(Date.now() - 6 * HOUR));
    for (let i = 0; i < 5; i++) {
      await strikeAt(tenant.tenantId, `i3t-earlier-${i}`, new Date(Date.now() - 2 * HOUR + i * 1000));
    }
    const { deps } = makeDeps('+15125550204');
    const money = await seedMoney(tenant.tenantId, 'Birch Supply', 31000);
    const ref = (s: string) => ({ tenantId: tenant.tenantId, sessionId: s, ownerSession: true }) as const;

    const locked = await startVoiceApproval(deps, { ...ref('i3t-before-change'), action: 'approve', reference: 'the Birch payment' });
    expect(locked.outcome).toBe('challenge_lockout');

    const app = settingsApp(tenant.tenantId, tenant.userId);
    const weak = await request(app).put('/api/settings/voice-approval-pin').send({ pin: '1234' });
    expect(weak.status).toBe(400);
    expect(weak.body.details).toMatchObject({ field: 'pin', reason: 'sequence' });
    const stillLocked = await startVoiceApproval(deps, { ...ref('i3t-after-weak'), action: 'approve', reference: 'the Birch payment' });
    expect(stillLocked.outcome).toBe('challenge_lockout');

    const changed = await request(app).put('/api/settings/voice-approval-pin').send({ pin: NEW_PIN });
    expect(changed.status).toBe(204);
    const stored = await settingsRepo.findByTenant(tenant.tenantId);
    expect(Date.parse(stored!.escalationSettings!.voice_approval_pin_changed_at!)).toBeGreaterThan(Date.now() - 60_000);

    const after = await callWithCodes(deps, ref('i3t-after-change'), 'the Birch payment', ['five three eight two']);
    expect(after.outcomes).toEqual(['approved']);
    expect((await proposalRepo.findById(tenant.tenantId, money.id))?.status).toBe('approved');
  });

  it('strikes older than 24h, and strikes from before the PIN change, do not count', async () => {
    const tenant = await freshTenant();
    await enrollAt(tenant.tenantId, PIN, new Date(Date.now() - 2 * HOUR));
    await strikeAt(tenant.tenantId, 'i3t-last-week', new Date(Date.now() - 26 * HOUR));
    await strikeAt(tenant.tenantId, 'i3t-yesterday', new Date(Date.now() - 25 * HOUR));
    await strikeAt(tenant.tenantId, 'i3t-old-pin', new Date(Date.now() - 3 * HOUR));
    for (let i = 0; i < 3; i++) {
      await strikeAt(tenant.tenantId, `i3t-recent-${i}`, new Date(Date.now() - HOUR + i * 1000));
    }
    const { deps } = makeDeps('+15125550205');
    await seedMoney(tenant.tenantId, 'Cedar Roofing', 12000);
    const ref = { tenantId: tenant.tenantId, sessionId: 'i3t-window', ownerSession: true } as const;

    // 6 strike rows exist, 3 count: the 4th is allowed, the 5th locks.
    const r = await callWithCodes(deps, ref, 'the Cedar payment', ['0000', '8888', '4271']);
    expect(r.outcomes).toEqual(['challenge_failed', 'challenge_lockout']);
  });

  it('migration 279’s partial index exists and serves the strike lookup SQL', async () => {
    const { rows: idx } = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'audit_events' AND indexname = 'idx_audit_events_voice_pin_lock'`,
    );
    expect(idx).toHaveLength(1);
    expect(idx[0].indexdef).toContain('WHERE');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      await client.query(`PREPARE i3t_pin_lock AS ${VOICE_APPROVAL_PIN_LOCK_EVENTS_SQL}`);
      const { rows: plan } = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN EXECUTE i3t_pin_lock('${crypto.randomUUID()}', now() - interval '48 hours')`,
      );
      await client.query('DEALLOCATE i3t_pin_lock');
      await client.query('ROLLBACK');
      expect(plan.map((p) => p['QUERY PLAN']).join('\n')).toContain('idx_audit_events_voice_pin_lock');
    } finally {
      client.release();
    }
  });
});

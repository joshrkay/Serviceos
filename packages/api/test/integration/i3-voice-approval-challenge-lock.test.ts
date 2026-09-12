import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { ensureTenantSettings, DEFAULT_ESCALATION_SETTINGS } from '../../src/settings/settings';
import { hashVoiceApprovalPin } from '../../src/settings/voice-approval-pin';
import {
  startVoiceApproval,
  continueVoiceApproval,
  type VoiceApprovalDeps,
  type VoiceApprovalSessionState,
  type PendingVoiceApproval,
} from '../../src/ai/tasks/proposal-approval-task';
import {
  createProposal,
  type Proposal,
  type ProposalType,
} from '../../src/proposals/proposal';

/**
 * I3 (§5, PRD row I3) at REAL Postgres — "spoken approval of money requires a
 * challenge; three wrong codes lock money/irreversible while capture still
 * approves; the lock survives a cancelled-and-restarted dialogue".
 *
 * The invariant was previously proven in memory only
 * (`test/ai/tasks/proposal-approval-task.test.ts`, an InMemoryProposalRepository
 * + InMemoryAuditRepository). This file drives the SAME product seams —
 * `startVoiceApproval` (src/ai/tasks/proposal-approval-task.ts:794) and
 * `continueVoiceApproval` (…:1216) — against a real `PgProposalRepository`,
 * `PgSettingsRepository` and `PgAuditRepository`, and reads every attempt's
 * audit row back through `PgAuditRepository.findByEntity`
 * (src/audit/pg-audit.ts:48).
 *
 * Seams under test:
 *   - challenge verify + session fail counter — proposal-approval-task.ts:1412
 *   - 3rd failure → lockout + one-tap SMS      — proposal-approval-task.ts:1414-1428
 *   - post-lockout refusal of money/irreversible — proposal-approval-task.ts:583
 *   - capture-class bypasses the challenge      — proposal-approval-task.ts:369 (requiresChallenge)
 *
 * The SMS transport is stubbed (an external send, not a DB leg); every
 * proposal row, settings row and audit row in this file is real Postgres.
 *
 * DURABILITY FINDING — see the final `it.fails` block: the lock lives ONLY on
 * the in-process voice session (`voice-session-store.ts:310` holds
 * `voiceApprovalState` on an in-memory `Map`; `voice-session-store.ts:5-7`
 * documents "single-process, in-memory map"). Nothing about the lockout is
 * persisted, so a session rebuilt from the real store — a mid-call reconnect
 * onto a second Railway replica, or a process restart — re-prompts the
 * challenge with the counter back at zero.
 */

const PIN_SECRET = 'i3-integration-pin-secret';
const TENANT_A_PIN = '4271';
const TENANT_B_PIN = '5382';

interface Harness {
  deps: VoiceApprovalDeps;
  sent: { to: string; body: string }[];
}

function makeDeps(
  proposalRepo: PgProposalRepository,
  auditRepo: PgAuditRepository,
  settingsRepo: PgSettingsRepository,
  ownerPhone: string,
): Harness {
  const sent: { to: string; body: string }[] = [];
  const deps: VoiceApprovalDeps = {
    proposalRepo,
    auditRepo,
    settingsRepo,
    smsEventRepo: { hasUnappliedEditRequest: async () => false },
    oneTapFallback: {
      sendSms: async (to, body) => {
        sent.push({ to, body });
      },
      secret: 'i3-one-tap-secret',
      buildApproveUrl: (token) => `https://x.test/approve?token=${token}`,
      resolveOwnerPhone: async () => ownerPhone,
    },
  };
  return { deps, sent };
}

async function seedPending(
  proposalRepo: PgProposalRepository,
  tenantId: string,
  opts: { proposalType: ProposalType; summary: string; payload: Record<string, unknown> },
): Promise<Proposal> {
  const proposal = createProposal({
    tenantId,
    proposalType: opts.proposalType,
    payload: opts.payload,
    summary: opts.summary,
    createdBy: 'voice',
  });
  await proposalRepo.create(proposal);
  await proposalRepo.updateStatus(tenantId, proposal.id, 'ready_for_review');
  return (await proposalRepo.findById(tenantId, proposal.id))!;
}

/** Walk start → "yes" → challenge prompt for a money-class proposal. */
async function reachChallengeStage(
  deps: VoiceApprovalDeps,
  ref: { tenantId: string; sessionId: string; ownerSession: true },
  reference: string,
  sessionState?: VoiceApprovalSessionState,
): Promise<PendingVoiceApproval> {
  const start = await startVoiceApproval(deps, {
    ...ref,
    ...(sessionState ? { sessionState } : {}),
    action: 'approve',
    reference,
  });
  expect(start.outcome).toBe('readback');
  const confirm = await continueVoiceApproval(deps, {
    ...ref,
    ...(sessionState ? { sessionState } : {}),
    utterance: 'yes',
    pending: start.pending!,
  });
  expect(confirm.outcome).toBe('challenge_prompt');
  return confirm.pending!;
}

async function eventTypesFor(
  auditRepo: PgAuditRepository,
  tenantId: string,
  proposalId: string,
): Promise<string[]> {
  const rows = await auditRepo.findByEntity(tenantId, 'proposal', proposalId);
  return rows.map((r) => r.eventType);
}

describe('I3 — money-class voice approval challenge + three-strike lock at real Postgres', () => {
  let pool: Pool;
  let proposalRepo: PgProposalRepository;
  let auditRepo: PgAuditRepository;
  let settingsRepo: PgSettingsRepository;
  let tenantA: { tenantId: string; userId: string };
  let tenantB: { tenantId: string; userId: string };
  let previousSecret: string | undefined;

  beforeAll(async () => {
    previousSecret = process.env.TENANT_ENCRYPTION_KEY;
    process.env.TENANT_ENCRYPTION_KEY = PIN_SECRET;

    pool = await getSharedTestDb();
    proposalRepo = new PgProposalRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);

    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);

    // createTestTenant inserts tenants/users only; PgSettingsRepository.update
    // is a bare UPDATE, so the settings row must exist first.
    for (const [tenant, pin] of [
      [tenantA, TENANT_A_PIN],
      [tenantB, TENANT_B_PIN],
    ] as const) {
      const existing = await ensureTenantSettings(tenant.tenantId, settingsRepo);
      await settingsRepo.update(tenant.tenantId, {
        escalationSettings: {
          ...DEFAULT_ESCALATION_SETTINGS,
          ...existing.escalationSettings,
          voice_approval_pin_hash: hashVoiceApprovalPin(pin, tenant.tenantId, PIN_SECRET),
        },
      });
    }
  });

  afterAll(async () => {
    if (previousSecret === undefined) delete process.env.TENANT_ENCRYPTION_KEY;
    else process.env.TENANT_ENCRYPTION_KEY = previousSecret;
    await closeSharedTestDb();
  });

  it('three wrong codes lock money approval, and every attempt lands its audit row read back through PgAuditRepository.findByEntity', async () => {
    const { deps, sent } = makeDeps(proposalRepo, auditRepo, settingsRepo, '+15125550100');
    const ref = { tenantId: tenantA.tenantId, sessionId: 'i3-sess-lock', ownerSession: true } as const;

    const proposal = await seedPending(proposalRepo, tenantA.tenantId, {
      proposalType: 'record_payment',
      summary: 'Record $200 payment from Acme',
      payload: { customerName: 'Acme Corp', amountCents: 20000 },
    });

    let pending = await reachChallengeStage(deps, ref, 'the Acme payment');
    let sessionState: VoiceApprovalSessionState | undefined;

    for (let attempt = 1; attempt <= 2; attempt++) {
      const failed = await continueVoiceApproval(deps, {
        ...ref,
        ...(sessionState ? { sessionState } : {}),
        utterance: '0 0 0 0',
        pending,
      });
      expect(failed.outcome).toBe('challenge_failed');
      expect(failed.sessionState).toMatchObject({ challengeFailCount: attempt });
      pending = failed.pending!;
      sessionState = { ...sessionState, ...failed.sessionState };
    }

    const lockout = await continueVoiceApproval(deps, {
      ...ref,
      ...(sessionState ? { sessionState } : {}),
      utterance: '9 9 9 9',
      pending,
    });
    expect(lockout.outcome).toBe('challenge_lockout');
    expect(lockout.sessionState).toMatchObject({
      challengeFailCount: 3,
      challengeLockedOut: true,
    });
    expect(sent).toHaveLength(1);

    // The proposal is UNCHANGED in real Postgres — three wrong codes approve
    // nothing.
    const persisted = await proposalRepo.findById(tenantA.tenantId, proposal.id);
    expect(persisted?.status).toBe('ready_for_review');

    // Every attempt left its row, read back through the real repository.
    const types = await eventTypesFor(auditRepo, tenantA.tenantId, proposal.id);
    expect(types.filter((t) => t === 'proposal.voice_approval_challenge_failed')).toHaveLength(2);
    expect(types.filter((t) => t === 'proposal.voice_challenge_lockout')).toHaveLength(1);

    // The spoken codes must never reach the audit trail.
    const rows = await auditRepo.findByEntity(tenantA.tenantId, 'proposal', proposal.id);
    const lockoutRow = rows.find((r) => r.eventType === 'proposal.voice_challenge_lockout')!;
    expect(lockoutRow.metadata).toMatchObject({ attemptCount: 3 });
    expect(JSON.stringify(rows.map((r) => r.metadata))).not.toContain('0000');
    expect(JSON.stringify(rows.map((r) => r.metadata))).not.toContain('9999');
  });

  it('the lock survives the dialogue being CANCELLED and restarted — the third wrong code across three dialogues still locks', async () => {
    const { deps } = makeDeps(proposalRepo, auditRepo, settingsRepo, '+15125550101');
    const ref = {
      tenantId: tenantA.tenantId,
      sessionId: 'i3-sess-cancel-restart',
      ownerSession: true,
    } as const;

    const proposal = await seedPending(proposalRepo, tenantA.tenantId, {
      proposalType: 'record_payment',
      summary: 'Record $310 payment from Bellweather',
      payload: { customerName: 'Bellweather Ltd', amountCents: 31000 },
    });

    let sessionState: VoiceApprovalSessionState | undefined;

    // Dialogue 1: one wrong code, then the owner CANCELS out of the dialogue.
    let pending = await reachChallengeStage(deps, ref, 'the Bellweather payment', sessionState);
    const fail1 = await continueVoiceApproval(deps, {
      ...ref,
      utterance: '0 0 0 0',
      pending,
    });
    expect(fail1.outcome).toBe('challenge_failed');
    sessionState = { ...sessionState, ...fail1.sessionState };

    const cancelled = await continueVoiceApproval(deps, {
      ...ref,
      sessionState,
      utterance: 'never mind',
      pending: fail1.pending!,
    });
    expect(cancelled.outcome).toBe('kept_for_later');
    expect(cancelled.pending).toBeNull();

    // Dialogue 2: restarted from scratch — a wrong code here is attempt TWO,
    // not attempt one. The counter is session-level, not per-dialogue.
    pending = await reachChallengeStage(deps, ref, 'the Bellweather payment', sessionState);
    const fail2 = await continueVoiceApproval(deps, {
      ...ref,
      sessionState,
      utterance: '1 1 1 1',
      pending,
    });
    expect(fail2.outcome).toBe('challenge_failed');
    expect(fail2.sessionState).toMatchObject({ challengeFailCount: 2 });
    sessionState = { ...sessionState, ...fail2.sessionState };

    // Dialogue 2 is abandoned mid-challenge; dialogue 3 restarts again.
    pending = await reachChallengeStage(deps, ref, 'the Bellweather payment', sessionState);
    const lockout = await continueVoiceApproval(deps, {
      ...ref,
      sessionState,
      utterance: '2 2 2 2',
      pending,
    });
    expect(lockout.outcome).toBe('challenge_lockout');
    expect(lockout.sessionState).toMatchObject({ challengeFailCount: 3, challengeLockedOut: true });

    const persisted = await proposalRepo.findById(tenantA.tenantId, proposal.id);
    expect(persisted?.status).toBe('ready_for_review');

    const types = await eventTypesFor(auditRepo, tenantA.tenantId, proposal.id);
    expect(types.filter((t) => t === 'proposal.voice_approval_challenge_failed')).toHaveLength(2);
    expect(types.filter((t) => t === 'proposal.voice_challenge_lockout')).toHaveLength(1);
    // The cancel exited without burning an attempt, and said so in the trail.
    expect(types).toContain('proposal.voice_approval_declined');
  });

  it('once locked, a money proposal is refused while a capture-class proposal still approves — both outcomes persisted', async () => {
    const { deps, sent } = makeDeps(proposalRepo, auditRepo, settingsRepo, '+15125550102');
    const ref = {
      tenantId: tenantA.tenantId,
      sessionId: 'i3-sess-capture-still-works',
      ownerSession: true,
    } as const;

    const money = await seedPending(proposalRepo, tenantA.tenantId, {
      proposalType: 'record_payment',
      summary: 'Record $500 payment from Castillo',
      payload: { customerName: 'Castillo Roofing', amountCents: 50000 },
    });
    const capture = await seedPending(proposalRepo, tenantA.tenantId, {
      proposalType: 'add_note',
      summary: 'Note for Dunbar — gate code is on the work order',
      payload: { customerName: 'Dunbar Residence', note: 'gate code on the work order' },
    });

    const locked: VoiceApprovalSessionState = {
      challengeFailCount: 3,
      challengeLockedOut: true,
    };

    const refused = await startVoiceApproval(deps, {
      ...ref,
      sessionState: locked,
      action: 'approve',
      reference: 'the Castillo payment',
    });
    expect(refused.outcome).toBe('challenge_lockout');
    expect(refused.pending).toBeNull();
    expect((await proposalRepo.findById(tenantA.tenantId, money.id))?.status).toBe(
      'ready_for_review',
    );
    expect(await eventTypesFor(auditRepo, tenantA.tenantId, money.id)).toContain(
      'proposal.voice_approve_refused_challenge_lockout',
    );
    // The one-tap SMS is the escape hatch the refusal promises.
    expect(sent).toHaveLength(1);

    // …and the capture-class proposal approves in the SAME locked session.
    const start = await startVoiceApproval(deps, {
      ...ref,
      sessionState: locked,
      action: 'approve',
      reference: 'the Dunbar note',
    });
    expect(start.outcome).toBe('readback');
    const approved = await continueVoiceApproval(deps, {
      ...ref,
      sessionState: locked,
      utterance: 'yes',
      pending: start.pending!,
    });
    expect(approved.outcome).toBe('approved');
    expect((await proposalRepo.findById(tenantA.tenantId, capture.id))?.status).toBe('approved');
    expect(await eventTypesFor(auditRepo, tenantA.tenantId, capture.id)).toContain(
      'proposal.approved',
    );
  });

  it('T1 — tenant B’s lock state never leaks into tenant A, and neither do its audit rows (and the reverse)', async () => {
    const aHarness = makeDeps(proposalRepo, auditRepo, settingsRepo, '+15125550103');
    const bHarness = makeDeps(proposalRepo, auditRepo, settingsRepo, '+15125550104');
    const refA = {
      tenantId: tenantA.tenantId,
      sessionId: 'i3-sess-tenant-a',
      ownerSession: true,
    } as const;
    const refB = {
      tenantId: tenantB.tenantId,
      sessionId: 'i3-sess-tenant-b',
      ownerSession: true,
    } as const;

    const moneyA = await seedPending(proposalRepo, tenantA.tenantId, {
      proposalType: 'record_payment',
      summary: 'Record $700 payment from Everton',
      payload: { customerName: 'Everton Plumbing', amountCents: 70000 },
    });
    const moneyB = await seedPending(proposalRepo, tenantB.tenantId, {
      proposalType: 'record_payment',
      summary: 'Record $900 payment from Fairlane',
      payload: { customerName: 'Fairlane Group', amountCents: 90000 },
    });

    // Tenant B burns all three attempts and locks.
    let pendingB = await reachChallengeStage(bHarness.deps, refB, 'the Fairlane payment');
    let stateB: VoiceApprovalSessionState | undefined;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const failed = await continueVoiceApproval(bHarness.deps, {
        ...refB,
        ...(stateB ? { sessionState: stateB } : {}),
        utterance: '0 0 0 0',
        pending: pendingB,
      });
      expect(failed.outcome).toBe('challenge_failed');
      pendingB = failed.pending!;
      stateB = { ...stateB, ...failed.sessionState };
    }
    const lockoutB = await continueVoiceApproval(bHarness.deps, {
      ...refB,
      sessionState: stateB,
      utterance: '0 0 0 0',
      pending: pendingB,
    });
    expect(lockoutB.outcome).toBe('challenge_lockout');

    // Tenant A, in its own session, is NOT locked: it still reaches the
    // challenge prompt and approves with its own PIN.
    const pendingA = await reachChallengeStage(aHarness.deps, refA, 'the Everton payment');
    const approvedA = await continueVoiceApproval(aHarness.deps, {
      ...refA,
      utterance: 'four two seven one',
      pending: pendingA,
    });
    expect(approvedA.outcome).toBe('approved');
    expect((await proposalRepo.findById(tenantA.tenantId, moneyA.id))?.status).toBe('approved');

    // Tenant B's money proposal is untouched by tenant A's successful approval.
    expect((await proposalRepo.findById(tenantB.tenantId, moneyB.id))?.status).toBe(
      'ready_for_review',
    );

    // Cross-tenant read isolation: neither tenant can read the other's rows
    // for the other's proposal id.
    expect(await auditRepo.findByEntity(tenantA.tenantId, 'proposal', moneyB.id)).toHaveLength(0);
    expect(await auditRepo.findByEntity(tenantB.tenantId, 'proposal', moneyA.id)).toHaveLength(0);
    expect(await proposalRepo.findById(tenantA.tenantId, moneyB.id)).toBeNull();
    expect(await proposalRepo.findById(tenantB.tenantId, moneyA.id)).toBeNull();

    // And the reverse leak: tenant A's PIN does not open tenant B's challenge
    // (the HMAC is salted by tenantId — voice-approval-pin.ts:hashVoiceApprovalPin).
    const moneyB2 = await seedPending(proposalRepo, tenantB.tenantId, {
      proposalType: 'record_payment',
      summary: 'Record $150 payment from Garnet',
      payload: { customerName: 'Garnet Services', amountCents: 15000 },
    });
    const refB2 = {
      tenantId: tenantB.tenantId,
      sessionId: 'i3-sess-tenant-b-fresh',
      ownerSession: true,
    } as const;
    const pendingB2 = await reachChallengeStage(bHarness.deps, refB2, 'the Garnet payment');
    const crossPin = await continueVoiceApproval(bHarness.deps, {
      ...refB2,
      utterance: 'four two seven one',
      pending: pendingB2,
    });
    expect(crossPin.outcome).toBe('challenge_failed');
    expect((await proposalRepo.findById(tenantB.tenantId, moneyB2.id))?.status).toBe(
      'ready_for_review',
    );
  });

  /**
   * PRODUCT GAP, reported not fixed (test-only lane).
   *
   * The lockout is in-process state and nothing else. `challengeLockedOut`
   * lives on `VoiceApprovalSessionState` (proposal-approval-task.ts:142),
   * which the caller parks on the voice session
   * (voice-session-store.ts:310 `voiceApprovalState`), and that store is a
   * single-process in-memory `Map` (voice-session-store.ts:5-7). No column, no
   * row, no audit-derived recovery: a session rebuilt from the real store —
   * a mid-call reconnect landing on a second Railway replica, or an API
   * restart — arrives with `sessionState` empty and re-prompts the challenge
   * with the counter back at zero, even though three failures for this tenant
   * are sitting in `audit_events`.
   *
   * Written as `it.fails`: the assertion below states the DESIRED behaviour
   * (the lock is re-derived from the real store). It fails today. Product code
   * is deliberately untouched — closing this is a product decision that sits
   * with O-4/O-6 on #1000.
   */
  it.fails(
    'PRODUCT GAP — the lock does not survive a session rebuilt from the real store: a restarted session re-prompts the challenge although three failures are already in audit_events',
    async () => {
      const { deps } = makeDeps(proposalRepo, auditRepo, settingsRepo, '+15125550105');
      const proposal = await seedPending(proposalRepo, tenantA.tenantId, {
        proposalType: 'record_payment',
        summary: 'Record $410 payment from Holloway',
        payload: { customerName: 'Holloway Electric', amountCents: 41000 },
      });

      const ref = {
        tenantId: tenantA.tenantId,
        sessionId: 'i3-sess-durability',
        ownerSession: true,
      } as const;

      let pending = await reachChallengeStage(deps, ref, 'the Holloway payment');
      let sessionState: VoiceApprovalSessionState | undefined;
      for (let attempt = 1; attempt <= 2; attempt++) {
        const failed = await continueVoiceApproval(deps, {
          ...ref,
          ...(sessionState ? { sessionState } : {}),
          utterance: '0 0 0 0',
          pending,
        });
        pending = failed.pending!;
        sessionState = { ...sessionState, ...failed.sessionState };
      }
      const lockout = await continueVoiceApproval(deps, {
        ...ref,
        sessionState,
        utterance: '0 0 0 0',
        pending,
      });
      expect(lockout.outcome).toBe('challenge_lockout');

      // The lockout IS in real Postgres — it just isn't read back.
      const types = await eventTypesFor(auditRepo, tenantA.tenantId, proposal.id);
      expect(types).toContain('proposal.voice_challenge_lockout');

      // The call continues on a rebuilt session: same tenant, same call, but
      // the in-memory session state is gone (replica hop / process restart).
      const rebuilt = await startVoiceApproval(deps, {
        ...ref,
        action: 'approve',
        reference: 'the Holloway payment',
      });

      // DESIRED: still locked. ACTUAL today: 'readback' — the challenge is
      // re-prompted and the attacker gets three fresh tries.
      expect(rebuilt.outcome).toBe('challenge_lockout');
    },
  );
});

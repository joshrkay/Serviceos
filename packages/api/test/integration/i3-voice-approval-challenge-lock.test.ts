import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import type { AuditRepository } from '../../src/audit/audit';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { ensureTenantSettings, DEFAULT_ESCALATION_SETTINGS } from '../../src/settings/settings';
import { hashVoiceApprovalPin } from '../../src/settings/voice-approval-pin';
import {
  startVoiceApproval,
  continueVoiceApproval,
  spokenDigits,
  type VoiceApprovalDeps,
  type VoiceApprovalSessionState,
  type VoiceApprovalTurnResult,
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
 * `startVoiceApproval` (src/ai/tasks/proposal-approval-task.ts:910) and
 * `continueVoiceApproval` (…:1332) — against a real `PgProposalRepository`,
 * `PgSettingsRepository` and `PgAuditRepository`, and reads every attempt's
 * audit row back through `PgAuditRepository.findByEntity`
 * (src/audit/pg-audit.ts:48).
 *
 * Seams under test:
 *   - challenge verify + session fail counter — proposal-approval-task.ts:1541
 *   - 3rd failure → lockout + one-tap SMS      — proposal-approval-task.ts:1542-1557
 *   - post-lockout refusal of money/irreversible — proposal-approval-task.ts:656 (refuseChallengeLocked)
 *   - lock re-derived from audit_events (#1051) — proposal-approval-task.ts:419 (resolveChallengeLock),
 *     checked at readback :717, confirm :1456 and challenge :1510
 *   - capture-class bypasses the challenge      — proposal-approval-task.ts:371 (requiresChallenge)
 *
 * The SMS transport is stubbed (an external send, not a DB leg); every
 * proposal row, settings row and audit row in this file is real Postgres.
 *
 * DURABILITY (#1051) — see the `#1051` tests at the end of this file. The
 * in-memory counter still lives on the voice session (`voiceApprovalState` on
 * the single-process `VoiceSessionStore` Map), but it is no longer the only
 * record: the task re-derives the three-strike lock from the strike rows
 * already in `audit_events` (`proposal.voice_approval_challenge_failed` /
 * `proposal.voice_challenge_lockout`, correlated to the voice session id,
 * tenant-scoped) before every money-class step. A session rebuilt with the
 * same id and no in-memory state — a restart, a deploy, another replica —
 * therefore refuses money approval instead of re-prompting with the counter
 * at zero, and a failed lookup fails CLOSED.
 *
 * WHAT THIS FILE DOES NOT REACH: the session boundary itself. Every test here
 * calls the task functions directly and hands them `sessionState` by hand, so
 * the binding of a session to its tenant and to its `voiceApprovalState`
 * (`voice-session-store.ts`, supplied by `create-voice-turn-processor.ts`
 * as `sessionState: session.voiceApprovalState`) is never exercised at real
 * Postgres. The #1051 rebuild is additionally driven through that boundary
 * (Gather adapter → voice-turn processor → task) in
 * `test/telephony/voice-approval-gather.test.ts`, with an in-memory audit
 * repository.
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
  /** Enrolled with tenant A's digest verbatim — see the replayed-digest test. */
  let tenantC: { tenantId: string; userId: string };
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
    tenantC = await createTestTenant(pool);

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

    // Tenant C is enrolled with tenant A's digest COPIED VERBATIM — the exact
    // shape of a leaked hash replayed into another tenant's settings row. It
    // must not verify under tenant C, because verification re-derives the HMAC
    // with tenant C's id (voice-approval-pin.ts: the tenantId is the salt).
    const existingC = await ensureTenantSettings(tenantC.tenantId, settingsRepo);
    await settingsRepo.update(tenantC.tenantId, {
      escalationSettings: {
        ...DEFAULT_ESCALATION_SETTINGS,
        ...existingC.escalationSettings,
        voice_approval_pin_hash: hashVoiceApprovalPin(
          TENANT_A_PIN,
          tenantA.tenantId,
          PIN_SECRET,
        ),
      },
    });
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

    // Every wrong code actually spoken this test, kept so the leak assertion
    // below checks these exact strings rather than a hand-written copy.
    const spoken: string[] = [];

    for (let attempt = 1; attempt <= 2; attempt++) {
      spoken.push('0 0 0 0');
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

    spoken.push('9 9 9 9');
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

    // The spoken codes must never reach the audit trail — in EITHER form. The
    // codes are spoken as "0 0 0 0" / "9 9 9 9", so checking only the
    // normalized "0000" / "9999" would sail past a regression that logged the
    // raw utterance verbatim. Both forms, driven off the strings actually
    // spoken above so the two can never drift apart.
    const rows = await auditRepo.findByEntity(tenantA.tenantId, 'proposal', proposal.id);
    const lockoutRow = rows.find((r) => r.eventType === 'proposal.voice_challenge_lockout')!;
    expect(lockoutRow.metadata).toMatchObject({ attemptCount: 3 });
    const metadataJson = JSON.stringify(rows.map((r) => r.metadata));
    expect(spoken).toHaveLength(3);
    for (const utterance of spoken) {
      expect(metadataJson).not.toContain(utterance);
      expect(metadataJson).not.toContain(spokenDigits(utterance));
    }
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

  /**
   * SCOPE OF THIS T1 CLAIM — read before citing it as lock-state isolation.
   *
   * What is PROVEN here, at real Postgres: tenant B burning its three attempts
   * neither approves anything of B's nor blocks A's own approval at this seam,
   * and neither tenant can read the other's proposal or audit rows.
   *
   * What is NOT proven: that the session→tenant binding is itself sound. This
   * test threads `stateB` to tenant B and nothing to tenant A *by hand*, so
   * "B's lock never reaches A" is true by construction of the harness. The
   * real association is made in `voice-session-store.ts:310` and supplied at
   * `create-voice-turn-processor.ts:3054` (`sessionState:
   * session.voiceApprovalState`); neither is exercised here, so a regression
   * that attached B's `voiceApprovalState` to A's session would leave every
   * assertion below green. Proving that needs the store + processor boundary,
   * which is the adapter layer this lane deliberately does not enter.
   */
  it('T1 — tenant B’s lockout neither approves its own proposals nor blocks tenant A at this seam, and neither tenant reads the other’s rows', async () => {
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

    // And the reverse direction: tenant A's PIN spoken at tenant B's challenge
    // is refused. NOTE this proves only that a WRONG pin is rejected — the two
    // tenants hold different PIN values, so it says nothing about the HMAC
    // salt. The salt is proven separately, in the replayed-digest test below.
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

  it('T1 — a leaked PIN digest cannot be replayed into another tenant: the HMAC is salted by tenantId', async () => {
    // The claim under test is voice-approval-pin.ts's own: "a per-tenant SALT
    // is folded in via `tenantId` in the HMAC input, so the same PIN under two
    // tenants yields different digests and a leaked digest cannot be replayed
    // across tenants." Asserting a *wrong* PIN is rejected (as the T1 test
    // above does) would stay green even if the salt were dropped, so this
    // pins the salt directly.

    // Same PIN material, two tenants → different digests.
    expect(hashVoiceApprovalPin(TENANT_A_PIN, tenantA.tenantId, PIN_SECRET)).not.toBe(
      hashVoiceApprovalPin(TENANT_A_PIN, tenantC.tenantId, PIN_SECRET),
    );

    // …and the behavioural half, through the real dialogue at real Postgres:
    // tenant C's settings row literally holds tenant A's digest (seeded in
    // beforeAll), and tenant A's PIN still does not open tenant C's challenge.
    const { deps } = makeDeps(proposalRepo, auditRepo, settingsRepo, '+15125550106');
    const money = await seedPending(proposalRepo, tenantC.tenantId, {
      proposalType: 'record_payment',
      summary: 'Record $260 payment from Ipswich',
      payload: { customerName: 'Ipswich Builders', amountCents: 26000 },
    });
    const ref = {
      tenantId: tenantC.tenantId,
      sessionId: 'i3-sess-replayed-digest',
      ownerSession: true,
    } as const;

    const pending = await reachChallengeStage(deps, ref, 'the Ipswich payment');
    const replayed = await continueVoiceApproval(deps, {
      ...ref,
      utterance: 'four two seven one',
      pending,
    });
    expect(replayed.outcome).toBe('challenge_failed');
    expect((await proposalRepo.findById(tenantC.tenantId, money.id))?.status).toBe(
      'ready_for_review',
    );
    expect(await eventTypesFor(auditRepo, tenantC.tenantId, money.id)).toContain(
      'proposal.voice_approval_challenge_failed',
    );
  });

  // ─── #1051 — the lock survives a session rebuilt from the store ──────────
  //
  // A REBUILT SESSION, as modelled here: the same tenant and the same voice
  // session id, handed to the task with NO `sessionState` and NO in-memory
  // strike count — exactly what a caller supplies once the adapter state is
  // gone (API restart, deploy, a mid-call reconnect onto another replica). The
  // lock is re-derived INSIDE the task functions, so this direct call is the
  // seam every caller shares: `create-voice-turn-processor.ts` hands
  // `session.voiceApprovalState` (undefined after a rebuild) straight through.
  // The processor/store boundary itself is additionally driven over Gather in
  // `test/telephony/voice-approval-gather.test.ts` (the #1051 test there).

  /** Drive three wrong codes on a money proposal in `ref`'s session → locked. */
  async function lockSession(
    deps: VoiceApprovalDeps,
    ref: { tenantId: string; sessionId: string; ownerSession: true },
    reference: string,
  ): Promise<VoiceApprovalTurnResult> {
    let pending = await reachChallengeStage(deps, ref, reference);
    let sessionState: VoiceApprovalSessionState | undefined;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const failed = await continueVoiceApproval(deps, {
        ...ref,
        ...(sessionState ? { sessionState } : {}),
        utterance: '0 0 0 0',
        pending,
      });
      expect(failed.outcome).toBe('challenge_failed');
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
    return lockout;
  }

  async function refusalRows(tenantId: string, proposalId: string) {
    const rows = await auditRepo.findByEntity(tenantId, 'proposal', proposalId);
    return rows.filter((r) => r.eventType === 'proposal.voice_approve_refused_challenge_lockout');
  }

  it('#1051 — three wrong codes lock the session; a session REBUILT from the store refuses money approval without a new challenge, and capture-class still approves', async () => {
    const { deps } = makeDeps(proposalRepo, auditRepo, settingsRepo, '+15125550105');
    const ref = {
      tenantId: tenantA.tenantId,
      sessionId: 'i3-sess-durability',
      ownerSession: true,
    } as const;
    const money = await seedPending(proposalRepo, tenantA.tenantId, {
      proposalType: 'record_payment',
      summary: 'Record $410 payment from Holloway',
      payload: { customerName: 'Holloway Electric', amountCents: 41000 },
    });

    await lockSession(deps, ref, 'the Holloway payment');
    const lockedTypes = await eventTypesFor(auditRepo, tenantA.tenantId, money.id);
    expect(lockedTypes).toContain('proposal.voice_challenge_lockout');
    const promptsBeforeRebuild = lockedTypes.filter(
      (t) => t === 'proposal.voice_approval_challenge_prompted',
    ).length;

    // The call continues on a REBUILT session — same tenant, same session id,
    // in-memory state gone.
    const rebuilt = await startVoiceApproval(deps, {
      ...ref,
      action: 'approve',
      reference: 'the Holloway payment',
    });
    expect(rebuilt.outcome).toBe('challenge_lockout');
    expect(rebuilt.pending).toBeNull();
    // The re-derived strikes are handed back for the caller to park on the
    // rebuilt session, so later turns see the lock without another lookup.
    expect(rebuilt.sessionState).toMatchObject({ challengeFailCount: 3, challengeLockedOut: true });
    expect((await proposalRepo.findById(tenantA.tenantId, money.id))?.status).toBe(
      'ready_for_review',
    );
    const refusals = await refusalRows(tenantA.tenantId, money.id);
    expect(refusals).toHaveLength(1);
    expect(refusals[0].metadata).toMatchObject({
      lockSource: 'audit_trail',
      sessionId: ref.sessionId,
    });

    // A dialogue parked at the CONFIRM stage is re-checked before the
    // challenge is prompted: "yes" is refused, not answered with a prompt.
    const atConfirm = await continueVoiceApproval(deps, {
      ...ref,
      utterance: 'yes',
      pending: { action: 'approve', stage: 'confirm', proposalId: money.id },
    });
    expect(atConfirm.outcome).toBe('challenge_lockout');

    // A dialogue parked at the CHALLENGE stage is re-checked before the code
    // is verified: even the CORRECT code approves nothing in a locked session.
    const atChallenge = await continueVoiceApproval(deps, {
      ...ref,
      utterance: 'four two seven one',
      pending: { action: 'approve', stage: 'challenge', proposalId: money.id },
    });
    expect(atChallenge.outcome).toBe('challenge_lockout');
    expect((await proposalRepo.findById(tenantA.tenantId, money.id))?.status).toBe(
      'ready_for_review',
    );

    // No new challenge was ever prompted after the rebuild, and none passed.
    const afterTypes = await eventTypesFor(auditRepo, tenantA.tenantId, money.id);
    expect(
      afterTypes.filter((t) => t === 'proposal.voice_approval_challenge_prompted'),
    ).toHaveLength(promptsBeforeRebuild);
    expect(afterTypes).not.toContain('proposal.voice_approval_challenge_passed');
    expect(await refusalRows(tenantA.tenantId, money.id)).toHaveLength(3);

    // Capture-class approval still works in the rebuilt, locked session.
    const capture = await seedPending(proposalRepo, tenantA.tenantId, {
      proposalType: 'add_note',
      summary: 'Note for Juniper — side gate sticks',
      payload: { customerName: 'Juniper Residence', note: 'side gate sticks' },
    });
    const captureStart = await startVoiceApproval(deps, {
      ...ref,
      action: 'approve',
      reference: 'the Juniper note',
    });
    expect(captureStart.outcome).toBe('readback');
    const captureApproved = await continueVoiceApproval(deps, {
      ...ref,
      utterance: 'yes',
      pending: captureStart.pending!,
    });
    expect(captureApproved.outcome).toBe('approved');
    expect((await proposalRepo.findById(tenantA.tenantId, capture.id))?.status).toBe('approved');
  });

  it('#1051 — a rebuild after TWO strikes grants no fresh tries: the next wrong code in the rebuilt session is the third, and locks', async () => {
    const { deps } = makeDeps(proposalRepo, auditRepo, settingsRepo, '+15125550107');
    const ref = {
      tenantId: tenantA.tenantId,
      sessionId: 'i3-sess-rebuild-two-strikes',
      ownerSession: true,
    } as const;
    const money = await seedPending(proposalRepo, tenantA.tenantId, {
      proposalType: 'record_payment',
      summary: 'Record $330 payment from Kestrel',
      payload: { customerName: 'Kestrel Masonry', amountCents: 33000 },
    });

    let pending = await reachChallengeStage(deps, ref, 'the Kestrel payment');
    let sessionState: VoiceApprovalSessionState | undefined;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const failed = await continueVoiceApproval(deps, {
        ...ref,
        ...(sessionState ? { sessionState } : {}),
        utterance: '5 5 5 5',
        pending,
      });
      expect(failed.outcome).toBe('challenge_failed');
      pending = failed.pending!;
      sessionState = { ...sessionState, ...failed.sessionState };
    }

    // Rebuilt: two strikes are in audit_events, none in memory. Two is under
    // the cap, so the dialogue still reaches the challenge…
    const rebuiltPending = await reachChallengeStage(deps, ref, 'the Kestrel payment');
    // …but the next wrong code is strike THREE, not strike one.
    const third = await continueVoiceApproval(deps, {
      ...ref,
      utterance: '6 6 6 6',
      pending: rebuiltPending,
    });
    expect(third.outcome).toBe('challenge_lockout');
    expect(third.sessionState).toMatchObject({ challengeFailCount: 3, challengeLockedOut: true });
    expect((await proposalRepo.findById(tenantA.tenantId, money.id))?.status).toBe(
      'ready_for_review',
    );

    const rows = await auditRepo.findByEntity(tenantA.tenantId, 'proposal', money.id);
    expect(
      rows.filter((r) => r.eventType === 'proposal.voice_approval_challenge_failed'),
    ).toHaveLength(2);
    const lockoutRows = rows.filter((r) => r.eventType === 'proposal.voice_challenge_lockout');
    expect(lockoutRows).toHaveLength(1);
    expect(lockoutRows[0].metadata).toMatchObject({ attemptCount: 3 });
  });

  it('#1051 T1 within tenant — another voice session of the SAME tenant is not locked by this session’s audit trail', async () => {
    const { deps } = makeDeps(proposalRepo, auditRepo, settingsRepo, '+15125550108');
    const lockedRef = {
      tenantId: tenantA.tenantId,
      sessionId: 'i3-sess-t1-locked',
      ownerSession: true,
    } as const;
    const otherRef = {
      tenantId: tenantA.tenantId,
      sessionId: 'i3-sess-t1-other',
      ownerSession: true,
    } as const;
    const lockedMoney = await seedPending(proposalRepo, tenantA.tenantId, {
      proposalType: 'record_payment',
      summary: 'Record $120 payment from Lindqvist',
      payload: { customerName: 'Lindqvist Carpentry', amountCents: 12000 },
    });
    const otherMoney = await seedPending(proposalRepo, tenantA.tenantId, {
      proposalType: 'record_payment',
      summary: 'Record $240 payment from Marlowe',
      payload: { customerName: 'Marlowe Glass', amountCents: 24000 },
    });

    await lockSession(deps, lockedRef, 'the Lindqvist payment');

    // The locked session, rebuilt, still refuses…
    const stillLocked = await startVoiceApproval(deps, {
      ...lockedRef,
      action: 'approve',
      reference: 'the Marlowe payment',
    });
    expect(stillLocked.outcome).toBe('challenge_lockout');

    // …while a DIFFERENT session of the same tenant reaches the challenge and
    // approves with the right code.
    const pending = await reachChallengeStage(deps, otherRef, 'the Marlowe payment');
    const approved = await continueVoiceApproval(deps, {
      ...otherRef,
      utterance: 'four two seven one',
      pending,
    });
    expect(approved.outcome).toBe('approved');
    expect((await proposalRepo.findById(tenantA.tenantId, otherMoney.id))?.status).toBe(
      'approved',
    );
    expect((await proposalRepo.findById(tenantA.tenantId, lockedMoney.id))?.status).toBe(
      'ready_for_review',
    );
  });

  it('#1051 T1 across tenants — tenant B, in a session carrying the SAME session id as tenant A’s locked one, is not locked', async () => {
    const aHarness = makeDeps(proposalRepo, auditRepo, settingsRepo, '+15125550109');
    const bHarness = makeDeps(proposalRepo, auditRepo, settingsRepo, '+15125550110');
    const SHARED_SESSION_ID = 'i3-sess-shared-id-1051';
    const refA = {
      tenantId: tenantA.tenantId,
      sessionId: SHARED_SESSION_ID,
      ownerSession: true,
    } as const;
    const refB = {
      tenantId: tenantB.tenantId,
      sessionId: SHARED_SESSION_ID,
      ownerSession: true,
    } as const;

    const moneyA = await seedPending(proposalRepo, tenantA.tenantId, {
      proposalType: 'record_payment',
      summary: 'Record $560 payment from Norwood',
      payload: { customerName: 'Norwood Fencing', amountCents: 56000 },
    });
    // Divergent data: tenant B's own proposal, customer, amount and PIN.
    const moneyB = await seedPending(proposalRepo, tenantB.tenantId, {
      proposalType: 'record_payment',
      summary: 'Record $875 payment from Oakhurst',
      payload: { customerName: 'Oakhurst Pools', amountCents: 87500 },
    });

    await lockSession(aHarness.deps, refA, 'the Norwood payment');

    // Tenant B is not locked by tenant A's rows under the same session id: it
    // reaches the challenge and approves with ITS OWN code.
    const pendingB = await reachChallengeStage(bHarness.deps, refB, 'the Oakhurst payment');
    const approvedB = await continueVoiceApproval(bHarness.deps, {
      ...refB,
      utterance: 'five three eight two',
      pending: pendingB,
    });
    expect(approvedB.outcome).toBe('approved');
    expect((await proposalRepo.findById(tenantB.tenantId, moneyB.id))?.status).toBe('approved');

    // Tenant A's rebuilt session is still locked, and its proposal untouched.
    const rebuiltA = await startVoiceApproval(aHarness.deps, {
      ...refA,
      action: 'approve',
      reference: 'the Norwood payment',
    });
    expect(rebuiltA.outcome).toBe('challenge_lockout');
    expect((await proposalRepo.findById(tenantA.tenantId, moneyA.id))?.status).toBe(
      'ready_for_review',
    );

    // The trail the lock is derived from is tenant-scoped: under the shared
    // session id, tenant B reads no strike rows and tenant A reads its three.
    const strikeTypes = new Set([
      'proposal.voice_approval_challenge_failed',
      'proposal.voice_challenge_lockout',
    ]);
    const bRows = await auditRepo.findByCorrelation(tenantB.tenantId, SHARED_SESSION_ID);
    const aRows = await auditRepo.findByCorrelation(tenantA.tenantId, SHARED_SESSION_ID);
    expect(bRows.filter((r) => strikeTypes.has(r.eventType))).toHaveLength(0);
    expect(bRows.every((r) => r.tenantId === tenantB.tenantId)).toBe(true);
    expect(aRows.filter((r) => strikeTypes.has(r.eventType))).toHaveLength(3);
  });

  it('#1051 — an audit-lookup failure FAILS CLOSED: money approval refused and logged, never unlocked; capture-class still approves', async () => {
    const outage = new Error('simulated audit_events lookup outage');
    // Real Postgres for every write and every other read; only the lock's
    // correlation lookup is made to fail.
    const lookupDown: AuditRepository = {
      create: (event) => auditRepo.create(event),
      findByEntity: (tenantId, entityType, entityId) =>
        auditRepo.findByEntity(tenantId, entityType, entityId),
      findByCorrelation: async () => {
        throw outage;
      },
    };
    const { deps: healthyDeps } = makeDeps(proposalRepo, auditRepo, settingsRepo, '+15125550111');
    const deps: VoiceApprovalDeps = { ...healthyDeps, auditRepo: lookupDown };
    const ref = {
      tenantId: tenantA.tenantId,
      sessionId: 'i3-sess-lookup-down',
      ownerSession: true,
    } as const;
    const money = await seedPending(proposalRepo, tenantA.tenantId, {
      proposalType: 'record_payment',
      summary: 'Record $190 payment from Prescott',
      payload: { customerName: 'Prescott Tile', amountCents: 19000 },
    });

    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let refused: VoiceApprovalTurnResult;
    let atChallenge: VoiceApprovalTurnResult;
    let logged: string;
    try {
      // A FRESH session with zero strikes — it is the failed lookup, not a
      // strike count, that refuses.
      refused = await startVoiceApproval(deps, {
        ...ref,
        action: 'approve',
        reference: 'the Prescott payment',
      });
      atChallenge = await continueVoiceApproval(deps, {
        ...ref,
        utterance: 'four two seven one',
        pending: { action: 'approve', stage: 'challenge', proposalId: money.id },
      });
      logged = stderr.mock.calls.map((c) => String(c[0])).join('');
    } finally {
      stderr.mockRestore();
    }

    expect(refused.outcome).toBe('challenge_lockout');
    expect(refused.pending).toBeNull();
    // Even the correct code approves nothing while the lock cannot be read.
    expect(atChallenge.outcome).toBe('challenge_lockout');
    expect((await proposalRepo.findById(tenantA.tenantId, money.id))?.status).toBe(
      'ready_for_review',
    );
    const refusals = await refusalRows(tenantA.tenantId, money.id);
    expect(refusals).toHaveLength(2);
    expect(refusals.every((r) => r.metadata?.lockSource === 'lookup_failed')).toBe(true);

    // Logged, tenant- and session-tagged.
    expect(logged).toContain('voice approval challenge lock lookup failed');
    expect(logged).toContain(tenantA.tenantId);
    expect(logged).toContain(ref.sessionId);
    expect(logged).toContain(outage.message);

    // The refusal is per-turn, not a lock written onto the session: nothing
    // tells the caller to park `challengeLockedOut`.
    expect(refused.sessionState?.challengeLockedOut).toBeUndefined();
    // …and the link sent on this refusal is NOT marked as "the lockout link
    // already sent", so a later real lockout still texts the owner (#1217 review).
    expect(refused.sessionState?.oneTapSmsSentAfterLockout).toBeUndefined();

    // Capture-class approval does not depend on the lookup and still works.
    const capture = await seedPending(proposalRepo, tenantA.tenantId, {
      proposalType: 'add_note',
      summary: 'Note for Quillon — dog in the yard',
      payload: { customerName: 'Quillon Residence', note: 'dog in the yard' },
    });
    const captureStart = await startVoiceApproval(deps, {
      ...ref,
      action: 'approve',
      reference: 'the Quillon note',
    });
    expect(captureStart.outcome).toBe('readback');
    const captureApproved = await continueVoiceApproval(deps, {
      ...ref,
      utterance: 'yes',
      pending: captureStart.pending!,
    });
    expect(captureApproved.outcome).toBe('approved');
    expect((await proposalRepo.findById(tenantA.tenantId, capture.id))?.status).toBe('approved');

    // Once the lookup works again, the same session (zero strikes) is NOT
    // locked: the fail-closed refusal left no false lock behind.
    const recovered = await startVoiceApproval(healthyDeps, {
      ...ref,
      action: 'approve',
      reference: 'the Prescott payment',
    });
    expect(recovered.outcome).toBe('readback');
  });

  it('#1051 — a LOST strike write fails closed: the wrong code whose audit row cannot be written locks money approval in memory, a durable marker locks the rebuilt session, and capture still approves', async () => {
    const lostWrite = new Error('simulated audit_events insert failure');
    // Real Postgres for every read and every other write; only the
    // failed-code strike INSERT is lost.
    const strikeWriteLost: AuditRepository = {
      create: async (event) => {
        if (event.eventType === 'proposal.voice_approval_challenge_failed') throw lostWrite;
        return auditRepo.create(event);
      },
      findByEntity: (tenantId, entityType, entityId) =>
        auditRepo.findByEntity(tenantId, entityType, entityId),
      findByCorrelation: (tenantId, correlationId) =>
        auditRepo.findByCorrelation(tenantId, correlationId),
    };
    const { deps: healthyDeps } = makeDeps(proposalRepo, auditRepo, settingsRepo, '+15125550112');
    const deps: VoiceApprovalDeps = { ...healthyDeps, auditRepo: strikeWriteLost };
    const ref = {
      tenantId: tenantA.tenantId,
      sessionId: 'i3-sess-strike-write-lost',
      ownerSession: true,
    } as const;
    const money = await seedPending(proposalRepo, tenantA.tenantId, {
      proposalType: 'record_payment',
      summary: 'Record $270 payment from Rowan',
      payload: { customerName: 'Rowan Drywall', amountCents: 27000 },
    });

    const pending = await reachChallengeStage(deps, ref, 'the Rowan payment');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let lost: VoiceApprovalTurnResult;
    let logged: string;
    try {
      lost = await continueVoiceApproval(deps, { ...ref, utterance: '0 0 0 0', pending });
      logged = stderr.mock.calls.map((c) => String(c[0])).join('');
    } finally {
      stderr.mockRestore();
    }

    // The turn itself is unchanged (wrong code, try again) — but the session is
    // locked for money-class approval, and the loss is logged.
    expect(lost.outcome).toBe('challenge_failed');
    expect(lost.sessionState).toMatchObject({ challengeFailCount: 1, challengeLockedOut: true });
    expect(logged).toContain('voice approval strike audit write failed');
    expect(logged).toContain(tenantA.tenantId);
    expect(logged).toContain(ref.sessionId);
    expect(logged).toContain(lostWrite.message);

    // In memory: the kept challenge refuses even the correct code.
    const inMemory = await continueVoiceApproval(deps, {
      ...ref,
      sessionState: { ...lost.sessionState },
      utterance: 'four two seven one',
      pending: lost.pending!,
    });
    expect(inMemory.outcome).toBe('challenge_lockout');
    expect((await proposalRepo.findById(tenantA.tenantId, money.id))?.status).toBe(
      'ready_for_review',
    );

    // Real Postgres: no strike row, one durable lockout marker for this session.
    const trail = await auditRepo.findByCorrelation(tenantA.tenantId, ref.sessionId);
    expect(trail.filter((r) => r.eventType === 'proposal.voice_approval_challenge_failed')).toHaveLength(0);
    const markers = trail.filter((r) => r.eventType === 'proposal.voice_challenge_lockout');
    expect(markers).toHaveLength(1);
    expect(markers[0].metadata).toMatchObject({
      attemptCount: 1,
      reason: 'strike_write_failed',
      lostEventType: 'proposal.voice_approval_challenge_failed',
    });

    // Rebuilt session (no in-memory state) → locked from the marker.
    const rebuilt = await startVoiceApproval(deps, {
      ...ref,
      action: 'approve',
      reference: 'the Rowan payment',
    });
    expect(rebuilt.outcome).toBe('challenge_lockout');
    const refusals = await refusalRows(tenantA.tenantId, money.id);
    expect(refusals.map((r) => r.metadata?.lockSource).sort()).toEqual(['audit_trail', 'session']);

    // Capture-class still approves in the locked, rebuilt session.
    const capture = await seedPending(proposalRepo, tenantA.tenantId, {
      proposalType: 'add_note',
      summary: 'Note for Sorrel — back door code changed',
      payload: { customerName: 'Sorrel Residence', note: 'back door code changed' },
    });
    const captureStart = await startVoiceApproval(deps, {
      ...ref,
      action: 'approve',
      reference: 'the Sorrel note',
    });
    expect(captureStart.outcome).toBe('readback');
    const captureApproved = await continueVoiceApproval(deps, {
      ...ref,
      utterance: 'yes',
      pending: captureStart.pending!,
    });
    expect(captureApproved.outcome).toBe('approved');
    expect((await proposalRepo.findById(tenantA.tenantId, capture.id))?.status).toBe('approved');
  });
});

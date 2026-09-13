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
  spokenDigits,
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
 * DURABILITY FINDING — see the final test (#1051): the lock lives ONLY on the
 * in-process voice session (`voice-session-store.ts:310` holds
 * `voiceApprovalState` on an in-memory `Map`; `voice-session-store.ts:5-7`
 * documents "single-process, in-memory map"). Nothing about the lockout is
 * persisted, so a session rebuilt from the real store — a mid-call reconnect
 * onto a second Railway replica, or a process restart — re-prompts the
 * challenge with the counter back at zero.
 *
 * WHAT THIS FILE DOES NOT REACH: the session boundary itself. Every test here
 * calls the task functions directly and hands them `sessionState` by hand, so
 * the binding of a session to its tenant and to its `voiceApprovalState`
 * (`voice-session-store.ts:310`, supplied at
 * `create-voice-turn-processor.ts:3054`) is never exercised. Two consequences
 * are called out at the tests they affect: the T1 lock-isolation claim, and
 * the conditional alarm on the #1051 test.
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
   * This is an ORDINARY test that PINS the broken behaviour, not an
   * `it.fails`. `it.fails` passes when ANY assertion in the body throws, so it
   * would have swallowed a real I3 regression in the setup below — a failure
   * to reach the challenge, to lock on the third attempt, or to persist the
   * lockout row would all have read as "expected failure" and gone green.
   * (Verified: breaking the `lockout.outcome` assertion below still reported
   * `1 expected fail`.) Every setup assertion here is therefore live, and the
   * gap itself is pinned as the CURRENT value.
   *
   * THE ALARM IS CONDITIONAL, and the condition matters. This test calls
   * `startVoiceApproval` directly with no `sessionState`, which is NOT a
   * faithful rebuild of a production session: the real rebuild goes through
   * `VoiceSessionStore` (`voice-session-store.ts:310`) and the voice-turn
   * processor, which is what supplies `sessionState`
   * (`create-voice-turn-processor.ts:3054`). So:
   *   - if #1051 is closed INSIDE this task function, the last two assertions
   *     flip and this test goes red, as intended;
   *   - if #1051 is closed at the SESSION BOUNDARY — restoring
   *     `voiceApprovalState` when the session is reconstructed, which is the
   *     more likely shape — this test still sees `readback` and stays green.
   * Whoever closes #1051 must therefore extend or replace this test at the
   * store/processor boundary rather than trusting it to fail on its own. That
   * note is on #1051.
   *
   * Product code is deliberately untouched — closing this is a product
   * decision, tracked as #1051 and sitting next to O-4/O-6 on #1000.
   */
  it(
    'PRODUCT GAP (#1051) — the lock does not survive a session rebuilt from the real store: a restarted session re-prompts the challenge although three failures are already in audit_events',
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

      // DESIRED: 'challenge_lockout' — the lock re-derived from the real
      // store. ACTUAL today: 'readback' — the challenge is re-prompted and an
      // attacker gets three fresh tries. Pinned both ways so the assertion
      // cannot quietly pass for the wrong reason and so closing #1051 turns
      // this red.
      expect(rebuilt.outcome).toBe('readback');
      expect(rebuilt.outcome).not.toBe('challenge_lockout');
    },
  );
});

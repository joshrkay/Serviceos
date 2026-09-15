/**
 * #1051 follow-up — the TENANT-WIDE money-approval PIN lock.
 *
 * PR #1217 made the per-session three-strike lock survive a rebuilt session,
 * but a caller could still buy fresh guesses by starting a new call (a new
 * voice session id). The tenant-wide lock closes that: 5 failed money-approval
 * PIN strikes for one tenant inside a rolling 24h window — counted from the
 * durable strike rows in `audit_events`, only strikes after the latest PIN
 * change — lock voice money approval for the whole tenant, across every
 * session and call. The owner gets ONE alert (never an approval link) when the
 * lock engages; capture-class items are untouched; a failed strike lookup
 * refuses money approval (fail closed).
 *
 * #1233 review — the budget is enforced on RESERVED attempts: every code is
 * reserved durably before it is compared, re-counted including itself, and
 * refused uncompared when over the limit; a correct code, a cancel or a refusal
 * clears its reservation. Parallel calls therefore cannot buy a 6th guess, and
 * an attempt that cannot be reserved is never compared. The owner alert is
 * claimed (tenant + lock episode) before it is sent.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  startVoiceApproval,
  startVoiceBatchApproval,
  continueVoiceApproval,
  continueVoiceBatchApproval,
  VOICE_APPROVAL_ACTOR_ID,
  type VoiceApprovalDeps,
  type VoiceApprovalSessionState,
  type VoiceApprovalTurnResult,
} from '../../../src/ai/tasks/proposal-approval-task';
import {
  createProposal,
  InMemoryProposalRepository,
  type CreateProposalInput,
  type Proposal,
} from '../../../src/proposals/proposal';
import {
  createAuditEvent,
  InMemoryAuditRepository,
  type AuditEvent,
} from '../../../src/audit/audit';
import type { SettingsRepository } from '../../../src/settings/settings';

const TENANT = 't-pin-lock';
const NEIGHBOUR = 't-pin-lock-neighbour';
const PIN = '4271';
const OWNER_PHONE = '+15125550100';
const HOUR = 60 * 60 * 1000;

const STRIKE_FAILED = 'proposal.voice_approval_challenge_failed';
const STRIKE_LOCKOUT = 'proposal.voice_challenge_lockout';
const PIN_ATTEMPT = 'proposal.voice_approval_pin_attempt';
const PIN_ATTEMPT_CLEARED = 'proposal.voice_approval_pin_attempt_cleared';
const TENANT_LOCK_ALERTED = 'proposal.voice_approval_tenant_lock_alerted';
const REFUSED = 'proposal.voice_approve_refused_challenge_lockout';

function settingsRepo(pinChangedAt?: Date): SettingsRepository {
  return {
    findByTenant: async () => ({
      ownerPhone: OWNER_PHONE,
      escalationSettings: {
        voice_approval_challenge: PIN,
        ...(pinChangedAt ? { voice_approval_pin_changed_at: pinChangedAt.toISOString() } : {}),
      },
    }),
  } as unknown as SettingsRepository;
}

class TenantLookupDownAuditRepository extends InMemoryAuditRepository {
  async findVoiceApprovalPinLockEvents(): Promise<never> {
    throw new Error('tenant strike lookup down');
  }
}

/** Loses every write of the listed event types. */
class LosesWritesAuditRepository extends InMemoryAuditRepository {
  constructor(private readonly lost: readonly string[]) {
    super();
  }
  async create(event: AuditEvent): Promise<AuditEvent> {
    if (this.lost.includes(event.eventType)) throw new Error(`audit write lost: ${event.eventType}`);
    return super.create(event);
  }
}

interface AlertClaim {
  tenantId: string;
  episodeKey: string;
  sessionId?: string;
  strikeCount: number;
}

interface ClaimStore {
  claim(input: AlertClaim): Promise<boolean>;
}

/** Insert-if-absent on (tenant, episode), like the Pg table's primary key. */
function claimStore(rows: AlertClaim[]): ClaimStore {
  return {
    claim: async (input) => {
      if (rows.some((r) => r.tenantId === input.tenantId && r.episodeKey === input.episodeKey)) return false;
      rows.push(input);
      return true;
    },
  };
}

interface Harness {
  deps: VoiceApprovalDeps;
  proposalRepo: InMemoryProposalRepository;
  auditRepo: InMemoryAuditRepository;
  sent: { to: string; body: string }[];
  claims: AlertClaim[];
}

function makeHarness(
  opts: {
    pinChangedAt?: Date;
    auditRepo?: InMemoryAuditRepository | null;
    alertRepo?: ClaimStore;
    sendSms?: (to: string, body: string) => Promise<void>;
  } = {},
): Harness {
  const proposalRepo = new InMemoryProposalRepository();
  const auditRepo = opts.auditRepo === null ? undefined : (opts.auditRepo ?? new InMemoryAuditRepository());
  const sent: { to: string; body: string }[] = [];
  const claims: AlertClaim[] = [];
  const deps = {
    proposalRepo,
    auditRepo,
    settingsRepo: settingsRepo(opts.pinChangedAt),
    smsEventRepo: { hasUnappliedEditRequest: async () => false },
    pinLockAlertRepo: opts.alertRepo ?? claimStore(claims),
    oneTapFallback: {
      sendSms: async (to: string, body: string) => {
        if (opts.sendSms) await opts.sendSms(to, body);
        sent.push({ to, body });
      },
      secret: 'test-secret',
      buildApproveUrl: (token) => `https://x.test/approve?token=${token}`,
      resolveOwnerPhone: async () => OWNER_PHONE,
    },
  } as VoiceApprovalDeps;
  return { deps, proposalRepo, auditRepo: auditRepo as InMemoryAuditRepository, sent, claims };
}

async function seed(
  repo: InMemoryProposalRepository,
  input: Pick<CreateProposalInput, 'proposalType' | 'payload' | 'summary'>,
): Promise<Proposal> {
  const proposal = createProposal({ tenantId: TENANT, createdBy: 'voice', ...input });
  await repo.create(proposal);
  await repo.updateStatus(TENANT, proposal.id, 'ready_for_review');
  return (await repo.findById(TENANT, proposal.id))!;
}

const seedMoney = (repo: InMemoryProposalRepository, customerName: string, amountCents = 20000) =>
  seed(repo, {
    proposalType: 'record_payment',
    payload: { customerName, amountCents },
    summary: `Record $${amountCents / 100} payment from ${customerName}`,
  });

const seedCapture = (repo: InMemoryProposalRepository, customerName: string) =>
  seed(repo, {
    proposalType: 'draft_estimate',
    payload: {
      customerName,
      lineItems: [{ description: 'Water heater', total: 45000 }],
      totalCents: 45000,
    },
    summary: `Estimate for ${customerName} — water heater`,
  });

/**
 * A durable strike, as a wrong code in ANOTHER call (session) leaves it: a
 * reserved attempt that was never cleared.
 */
async function strikeRow(
  auditRepo: InMemoryAuditRepository,
  opts: { tenantId?: string; sessionId: string; at?: Date; eventType?: string },
): Promise<void> {
  const event: AuditEvent = createAuditEvent({
    tenantId: opts.tenantId ?? TENANT,
    actorId: VOICE_APPROVAL_ACTOR_ID,
    actorRole: 'system',
    eventType: opts.eventType ?? PIN_ATTEMPT,
    entityType: 'proposal',
    entityId: 'p-earlier-call',
    correlationId: opts.sessionId,
    metadata: { channel: 'voice', sessionId: opts.sessionId, attemptCount: 1 },
  });
  if (opts.at) event.createdAt = opts.at;
  await auditRepo.create(event);
}

/** `n` strikes, one per earlier call, `ageMs` old. */
async function strikesInOtherCalls(
  auditRepo: InMemoryAuditRepository,
  n: number,
  opts: { tenantId?: string; ageMs?: number; prefix?: string } = {},
): Promise<void> {
  for (let i = 0; i < n; i++) {
    await strikeRow(auditRepo, {
      tenantId: opts.tenantId,
      sessionId: `${opts.prefix ?? 'earlier-call'}-${i}`,
      at: new Date(Date.now() - (opts.ageMs ?? HOUR) - i * 1000),
    });
  }
}

const call = (sessionId: string) => ({ tenantId: TENANT, sessionId, ownerSession: true });

/** readback → "yes" for `reference` in `sessionId`. */
async function toConfirmOutcome(
  h: Harness,
  sessionId: string,
  reference: string,
  sessionState: VoiceApprovalSessionState = {},
): Promise<{ start: VoiceApprovalTurnResult; confirm?: VoiceApprovalTurnResult }> {
  const start = await startVoiceApproval(h.deps, {
    ...call(sessionId),
    sessionState,
    action: 'approve',
    reference,
  });
  if (start.outcome !== 'readback') return { start };
  const confirm = await continueVoiceApproval(h.deps, {
    ...call(sessionId),
    sessionState,
    utterance: 'yes',
    pending: start.pending!,
  });
  return { start, confirm };
}

function eventsOf(h: Harness, eventType: string): AuditEvent[] {
  return h.auditRepo.getAll().filter((e) => e.eventType === eventType);
}

/** Reserved attempts not cleared — what the tenant budget counts. */
function countedAttempts(h: Harness): number {
  const cleared = new Set(eventsOf(h, PIN_ATTEMPT_CLEARED).map((e) => e.metadata?.attemptId));
  return eventsOf(h, PIN_ATTEMPT).filter((e) => !cleared.has(e.id)).length;
}

function linkTexts(h: Harness): string[] {
  return h.sent.map((s) => s.body).filter((b) => /https?:\/\/|token=/.test(b));
}

async function quietly<T>(body: () => Promise<T>): Promise<T> {
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    return await body();
  } finally {
    spy.mockRestore();
  }
}

describe('#1051 tenant-wide PIN lock — the lock decision at the task seam', () => {
  it('4 strikes across earlier calls are allowed: a new call is prompted for the code and the right code approves', async () => {
    const h = makeHarness();
    await strikesInOtherCalls(h.auditRepo, 4);
    const money = await seedMoney(h.proposalRepo, 'Acme Corp');

    const { start, confirm } = await toConfirmOutcome(h, 'call-new', 'the Acme payment');
    expect(start.outcome).toBe('readback');
    expect(confirm!.outcome).toBe('challenge_prompt');

    const approved = await continueVoiceApproval(h.deps, {
      ...call('call-new'),
      utterance: 'four two seven one',
      pending: confirm!.pending!,
    });
    expect(approved.outcome).toBe('approved');
    expect((await h.proposalRepo.findById(TENANT, money.id))?.status).toBe('approved');
  });

  it('the 5th strike locks the whole tenant: the wrong code ends the dialogue, and a DIFFERENT call is refused before any challenge — even with the right code', async () => {
    const h = makeHarness();
    await strikesInOtherCalls(h.auditRepo, 4);
    const money = await seedMoney(h.proposalRepo, 'Acme Corp');

    const { confirm } = await toConfirmOutcome(h, 'call-five', 'the Acme payment');
    expect(confirm!.outcome).toBe('challenge_prompt');
    const fifth = await continueVoiceApproval(h.deps, {
      ...call('call-five'),
      utterance: '0 0 0 0',
      pending: confirm!.pending!,
    });
    // Only this call's FIRST wrong code — the session lock alone would say
    // challenge_failed and re-prompt. The tenant lock ends it.
    expect(fifth.outcome).toBe('challenge_lockout');
    expect(fifth.pending).toBeNull();
    const engaging = eventsOf(h, STRIKE_FAILED).find((e) => e.correlationId === 'call-five');
    expect(engaging?.metadata).toMatchObject({ tenantLockEngaged: true, tenantStrikeCount: 5 });

    // Another call — fresh session id, no in-memory state, zero session strikes.
    const refused = await startVoiceApproval(h.deps, {
      ...call('call-six'),
      action: 'approve',
      reference: 'the Acme payment',
    });
    expect(refused.outcome).toBe('challenge_lockout');
    expect(refused.pending).toBeNull();
    const refusal = eventsOf(h, REFUSED).find((e) => e.correlationId === 'call-six');
    expect(refusal?.metadata).toMatchObject({ lockSource: 'tenant_lock' });

    // A confirm or challenge turn smuggled into yet another call approves nothing.
    const atConfirm = await continueVoiceApproval(h.deps, {
      ...call('call-seven'),
      utterance: 'yes',
      pending: { action: 'approve', stage: 'confirm', proposalId: money.id },
    });
    expect(atConfirm.outcome).toBe('challenge_lockout');
    const atChallenge = await continueVoiceApproval(h.deps, {
      ...call('call-eight'),
      utterance: 'four two seven one',
      pending: { action: 'approve', stage: 'challenge', proposalId: money.id },
    });
    expect(atChallenge.outcome).toBe('challenge_lockout');
    expect((await h.proposalRepo.findById(TENANT, money.id))?.status).toBe('ready_for_review');
  });

  it('a strike from BEFORE the latest PIN change does not count', async () => {
    const pinChangedAt = new Date(Date.now() - 2 * HOUR);
    const h = makeHarness({ pinChangedAt });
    // 1 strike before the change + 4 after = 5 in the window, but only 4 count.
    await strikeRow(h.auditRepo, { sessionId: 'old-pin-call', at: new Date(Date.now() - 3 * HOUR) });
    await strikesInOtherCalls(h.auditRepo, 4);
    await seedMoney(h.proposalRepo, 'Acme Corp');

    const { start, confirm } = await toConfirmOutcome(h, 'call-after-change', 'the Acme payment');
    expect(start.outcome).toBe('readback');
    expect(confirm!.outcome).toBe('challenge_prompt');
    // …and the next wrong code is the 5th that counts: it locks.
    const fifth = await continueVoiceApproval(h.deps, {
      ...call('call-after-change'),
      utterance: '0 0 0 0',
      pending: confirm!.pending!,
    });
    expect(fifth.outcome).toBe('challenge_lockout');
  });

  it('a PIN change after the lock engaged unlocks the tenant (the count resets)', async () => {
    const h = makeHarness({ pinChangedAt: new Date(Date.now() - 60 * 1000) });
    await strikesInOtherCalls(h.auditRepo, 5); // all ~1h old, before the change
    await seedMoney(h.proposalRepo, 'Acme Corp');

    const { start } = await toConfirmOutcome(h, 'call-new-pin', 'the Acme payment');
    expect(start.outcome).toBe('readback');
  });

  it('a strike older than 24h does not count', async () => {
    const h = makeHarness();
    await strikeRow(h.auditRepo, { sessionId: 'yesterday', at: new Date(Date.now() - 25 * HOUR) });
    await strikesInOtherCalls(h.auditRepo, 4);
    await seedMoney(h.proposalRepo, 'Acme Corp');

    const { start, confirm } = await toConfirmOutcome(h, 'call-today', 'the Acme payment');
    expect(start.outcome).toBe('readback');
    expect(confirm!.outcome).toBe('challenge_prompt');
    // …while the 4 recent strikes DO count: the next wrong code is the 5th.
    const fifth = await continueVoiceApproval(h.deps, {
      ...call('call-today'),
      utterance: '0 0 0 0',
      pending: confirm!.pending!,
    });
    expect(fifth.outcome).toBe('challenge_lockout');
  });

  it('a neighbour tenant’s strikes never lock this tenant (T1)', async () => {
    const h = makeHarness();
    await strikesInOtherCalls(h.auditRepo, 8, { tenantId: NEIGHBOUR });
    const money = await seedMoney(h.proposalRepo, 'Acme Corp');

    const { confirm } = await toConfirmOutcome(h, 'call-t1', 'the Acme payment');
    expect(confirm!.outcome).toBe('challenge_prompt');
    const approved = await continueVoiceApproval(h.deps, {
      ...call('call-t1'),
      utterance: '4271',
      pending: confirm!.pending!,
    });
    expect(approved.outcome).toBe('approved');
    expect((await h.proposalRepo.findById(TENANT, money.id))?.status).toBe('approved');
  });

  it('a failed strike lookup REFUSES money approval at readback, confirm and challenge (fail closed) — capture still approves', async () => {
    const h = makeHarness({ auditRepo: new TenantLookupDownAuditRepository() });
    const money = await seedMoney(h.proposalRepo, 'Acme Corp');
    const capture = await seedCapture(h.proposalRepo, 'Henderson');

    await quietly(async () => {
      const atReadback = await startVoiceApproval(h.deps, {
        ...call('call-down'),
        action: 'approve',
        reference: 'the Acme payment',
      });
      expect(atReadback.outcome).toBe('challenge_lockout');
      expect(atReadback.sessionState?.challengeLockedOut).toBeUndefined();

      const atConfirm = await continueVoiceApproval(h.deps, {
        ...call('call-down'),
        utterance: 'yes',
        pending: { action: 'approve', stage: 'confirm', proposalId: money.id },
      });
      expect(atConfirm.outcome).toBe('challenge_lockout');

      const atChallenge = await continueVoiceApproval(h.deps, {
        ...call('call-down'),
        utterance: 'four two seven one',
        pending: { action: 'approve', stage: 'challenge', proposalId: money.id },
      });
      expect(atChallenge.outcome).toBe('challenge_lockout');
    });
    expect((await h.proposalRepo.findById(TENANT, money.id))?.status).toBe('ready_for_review');
    expect(eventsOf(h, REFUSED).every((e) => e.metadata?.lockSource === 'lookup_failed')).toBe(true);
    expect(eventsOf(h, REFUSED)).toHaveLength(3);

    const { start, confirm } = await toConfirmOutcome(h, 'call-down', 'the Henderson estimate');
    expect(start.outcome).toBe('readback');
    expect(confirm!.outcome).toBe('approved');
    expect((await h.proposalRepo.findById(TENANT, capture.id))?.status).toBe('approved');
  });

  it('capture-class items still approve by voice while the tenant is locked', async () => {
    const h = makeHarness();
    await strikesInOtherCalls(h.auditRepo, 5);
    const money = await seedMoney(h.proposalRepo, 'Acme Corp');
    const capture = await seedCapture(h.proposalRepo, 'Henderson');

    const moneyTry = await startVoiceApproval(h.deps, {
      ...call('call-mixed'),
      action: 'approve',
      reference: 'the Acme payment',
    });
    expect(moneyTry.outcome).toBe('challenge_lockout');

    const { start, confirm } = await toConfirmOutcome(h, 'call-mixed', 'the Henderson estimate');
    expect(start.outcome).toBe('readback');
    expect(confirm!.outcome).toBe('approved');
    expect((await h.proposalRepo.findById(TENANT, capture.id))?.status).toBe('approved');
    expect((await h.proposalRepo.findById(TENANT, money.id))?.status).toBe('ready_for_review');
  });
});

describe('#1233 review — the budget is enforced on attempts reserved BEFORE the PIN is compared', () => {
  /** Six calls, each already at the challenge prompt for its own money item. */
  async function sixCallsAtTheChallenge(h: Harness) {
    const calls = ['burst-1', 'burst-2', 'burst-3', 'burst-4', 'burst-5', 'burst-6'];
    const pendings = [];
    for (const [i, sessionId] of calls.entries()) {
      await seedMoney(h.proposalRepo, `Burst Customer ${i + 1}`, 1000 + i);
      const { confirm } = await toConfirmOutcome(h, sessionId, `the Burst Customer ${i + 1} payment`);
      expect(confirm!.outcome).toBe('challenge_prompt');
      pendings.push(confirm!.pending!);
    }
    return { calls, pendings };
  }

  it('parallel wrong codes at 4 strikes: at most ONE is compared, the rest are refused uncompared, and the count never reaches a 6th guess', async () => {
    const h = makeHarness();
    await strikesInOtherCalls(h.auditRepo, 4);
    const { calls, pendings } = await sixCallsAtTheChallenge(h);

    const results = await Promise.all(
      calls.map((sessionId, i) =>
        continueVoiceApproval(h.deps, { ...call(sessionId), utterance: '0 0 0 0', pending: pendings[i] }),
      ),
    );

    // A wrong code leaves a failed/lockout row only once it has been compared.
    const compared = h.auditRepo
      .getAll()
      .filter((e) => (e.eventType === STRIKE_FAILED || e.eventType === STRIKE_LOCKOUT) && calls.includes(e.correlationId!));
    expect(compared.length).toBeLessThanOrEqual(1);
    expect(countedAttempts(h)).toBe(4 + compared.length);
    expect(countedAttempts(h)).toBeLessThanOrEqual(5);
    expect(results.every((r) => r.outcome === 'challenge_lockout')).toBe(true);
    // Every call that was not compared was refused on the tenant lock.
    const refusals = eventsOf(h, REFUSED).filter((e) => calls.includes(e.correlationId!));
    expect(refusals).toHaveLength(calls.length - compared.length);
    expect(refusals.every((e) => e.metadata?.lockSource === 'tenant_lock')).toBe(true);
  });

  it('parallel wrong codes from ZERO strikes: never more than 5 compared', async () => {
    const h = makeHarness();
    const { calls, pendings } = await sixCallsAtTheChallenge(h);
    await Promise.all(
      calls.map((sessionId, i) =>
        continueVoiceApproval(h.deps, { ...call(sessionId), utterance: '0 0 0 0', pending: pendings[i] }),
      ),
    );
    const compared = h.auditRepo
      .getAll()
      .filter((e) => (e.eventType === STRIKE_FAILED || e.eventType === STRIKE_LOCKOUT) && calls.includes(e.correlationId!));
    expect(compared.length).toBeLessThanOrEqual(5);
    expect(countedAttempts(h)).toBeLessThanOrEqual(5);
  });

  it('a correct code clears its reservation — it never counts as a strike', async () => {
    const h = makeHarness();
    await strikesInOtherCalls(h.auditRepo, 4);
    const acme = await seedMoney(h.proposalRepo, 'Acme Corp');
    await seedMoney(h.proposalRepo, 'Beta Corp', 5000);

    const { confirm } = await toConfirmOutcome(h, 'call-right', 'the Acme payment');
    const ok = await continueVoiceApproval(h.deps, {
      ...call('call-right'),
      utterance: '4271',
      pending: confirm!.pending!,
    });
    expect(ok.outcome).toBe('approved');
    expect((await h.proposalRepo.findById(TENANT, acme.id))?.status).toBe('approved');
    const reserved = eventsOf(h, PIN_ATTEMPT).find((e) => e.correlationId === 'call-right');
    const cleared = eventsOf(h, PIN_ATTEMPT_CLEARED).find((e) => e.correlationId === 'call-right');
    expect(cleared?.metadata).toMatchObject({ attemptId: reserved!.id, reason: 'passed' });
    expect(countedAttempts(h)).toBe(4);

    // The next call still has its 5th guess.
    const { confirm: next } = await toConfirmOutcome(h, 'call-next', 'the Beta payment');
    expect(next!.outcome).toBe('challenge_prompt');
  });

  it('"cancel" at the challenge clears its reservation — no strike is spent', async () => {
    const h = makeHarness();
    await strikesInOtherCalls(h.auditRepo, 4);
    await seedMoney(h.proposalRepo, 'Acme Corp');
    const { confirm } = await toConfirmOutcome(h, 'call-cancel', 'the Acme payment');
    const kept = await continueVoiceApproval(h.deps, {
      ...call('call-cancel'),
      utterance: 'cancel',
      pending: confirm!.pending!,
    });
    expect(kept.outcome).toBe('kept_for_later');
    expect(countedAttempts(h)).toBe(4);
  });

  it('an attempt that cannot be RESERVED is refused without comparing — the right code approves nothing and no strike row is written', async () => {
    const h = makeHarness({ auditRepo: new LosesWritesAuditRepository([PIN_ATTEMPT]) });
    const money = await seedMoney(h.proposalRepo, 'Acme Corp');
    const { confirm } = await toConfirmOutcome(h, 'call-nowrite', 'the Acme payment');
    expect(confirm!.outcome).toBe('challenge_prompt');

    const right = await quietly(() =>
      continueVoiceApproval(h.deps, {
        ...call('call-nowrite'),
        utterance: 'four two seven one',
        pending: confirm!.pending!,
      }),
    );
    expect(right.outcome).toBe('challenge_lockout');
    expect(right.pending).toBeNull();
    expect((await h.proposalRepo.findById(TENANT, money.id))?.status).toBe('ready_for_review');
    expect(eventsOf(h, 'proposal.voice_approval_challenge_passed')).toHaveLength(0);
    const refusal = eventsOf(h, REFUSED).find((e) => e.correlationId === 'call-nowrite');
    expect(refusal?.metadata).toMatchObject({ lockSource: 'reservation_failed' });

    const wrong = await quietly(() =>
      continueVoiceApproval(h.deps, {
        ...call('call-nowrite'),
        utterance: '0 0 0 0',
        pending: confirm!.pending!,
      }),
    );
    expect(wrong.outcome).toBe('challenge_lockout');
    expect(eventsOf(h, STRIKE_FAILED)).toHaveLength(0);
  });

  it('no audit repository wired → nothing can be reserved → the challenge refuses, even with the right code', async () => {
    const h = makeHarness({ auditRepo: null });
    const money = await seedMoney(h.proposalRepo, 'Acme Corp');
    const refused = await quietly(() =>
      continueVoiceApproval(h.deps, {
        ...call('call-noaudit'),
        utterance: 'four two seven one',
        pending: { action: 'approve', stage: 'challenge', proposalId: money.id },
      }),
    );
    expect(refused.outcome).toBe('challenge_lockout');
    expect((await h.proposalRepo.findById(TENANT, money.id))?.status).toBe('ready_for_review');
  });
});

describe('#1233 review — the owner alert is CLAIMED before it is sent', () => {
  async function engageTheLock(h: Harness, sessionId = 'call-engage') {
    await strikesInOtherCalls(h.auditRepo, 4);
    await seedMoney(h.proposalRepo, 'Acme Corp');
    const { confirm } = await toConfirmOutcome(h, sessionId, 'the Acme payment');
    const r = await continueVoiceApproval(h.deps, {
      ...call(sessionId),
      utterance: '0 0 0 0',
      pending: confirm!.pending!,
    });
    expect(r.outcome).toBe('challenge_lockout');
  }

  it('a claim another call already holds → nothing is sent', async () => {
    const h = makeHarness({ alertRepo: { claim: async () => false } });
    await engageTheLock(h);
    expect(h.sent).toHaveLength(0);
  });

  it('a claim store that errors → nothing is sent (it could not be deduplicated)', async () => {
    const h = makeHarness({
      alertRepo: {
        claim: async () => {
          throw new Error('claim store down');
        },
      },
    });
    await quietly(() => engageTheLock(h));
    expect(h.sent).toHaveLength(0);
  });

  it('a send that fails after winning the claim is NOT retried by later refusals — no re-texting at the caller’s pace', async () => {
    let attempts = 0;
    const h = makeHarness({
      sendSms: async () => {
        attempts += 1;
        throw new Error('sms provider down');
      },
    });
    await quietly(() => engageTheLock(h));
    for (const sessionId of ['call-later-1', 'call-later-2', 'call-later-3']) {
      const r = await quietly(() =>
        startVoiceApproval(h.deps, { ...call(sessionId), action: 'approve', reference: 'the Acme payment' }),
      );
      expect(r.outcome).toBe('challenge_lockout');
    }
    expect(attempts).toBe(1);
    expect(h.claims).toHaveLength(1);
  });
});

describe('#1051 tenant-wide PIN lock — the owner alert', () => {
  it('when the lock first engages the owner gets exactly ONE alert, with no approval link — and no one-tap link goes out while locked', async () => {
    const h = makeHarness();
    // 2 strikes in earlier calls; this call's 3rd wrong code is both the
    // SESSION lockout and the tenant's 5th strike.
    await strikesInOtherCalls(h.auditRepo, 2);
    const acme = await seedMoney(h.proposalRepo, 'Acme Corp');
    const beta = await seedMoney(h.proposalRepo, 'Beta Corp', 5000);

    const { confirm } = await toConfirmOutcome(h, 'call-attack', 'the Acme payment');
    let pending = confirm!.pending!;
    let state: VoiceApprovalSessionState = {};
    const outcomes: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await continueVoiceApproval(h.deps, {
        ...call('call-attack'),
        sessionState: state,
        utterance: '0 0 0 0',
        pending,
      });
      outcomes.push(r.outcome);
      state = { ...state, ...r.sessionState };
      if (r.pending) pending = r.pending;
    }
    expect(outcomes).toEqual(['challenge_failed', 'challenge_failed', 'challenge_lockout']);

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].to).toBe(OWNER_PHONE);
    expect(h.sent[0].body).not.toMatch(/https?:\/\/|token=|approve\?/i);
    expect(h.sent[0].body.toLowerCase()).toContain('locked');
    expect(eventsOf(h, TENANT_LOCK_ALERTED)).toHaveLength(1);
    // Claimed once, keyed by the attempt that engaged the lock (this call's 3rd code).
    const engaging = eventsOf(h, PIN_ATTEMPT).filter((e) => e.correlationId === 'call-attack').pop();
    expect(h.claims).toEqual([
      expect.objectContaining({ tenantId: TENANT, episodeKey: engaging!.id, strikeCount: 5 }),
    ]);

    // More attempts while it stays locked: the same call, and new calls.
    await startVoiceApproval(h.deps, {
      ...call('call-attack'),
      sessionState: state,
      action: 'approve',
      reference: 'the Beta payment',
    });
    for (const sessionId of ['call-again-1', 'call-again-2']) {
      const r = await startVoiceApproval(h.deps, {
        ...call(sessionId),
        action: 'approve',
        reference: 'the Beta payment',
      });
      expect(r.outcome).toBe('challenge_lockout');
    }

    expect(h.sent).toHaveLength(1); // still the one alert
    expect(linkTexts(h)).toEqual([]); // never an approval link
    expect(eventsOf(h, TENANT_LOCK_ALERTED)).toHaveLength(1);
    expect(h.claims).toHaveLength(1);
    for (const p of [acme, beta]) {
      expect((await h.proposalRepo.findById(TENANT, p.id))?.status).toBe('ready_for_review');
    }
  });

  it('a batch walk on a locked tenant approves capture items, refuses money, and texts no approval link', async () => {
    const h = makeHarness();
    await strikesInOtherCalls(h.auditRepo, 5);
    const capture = await seedCapture(h.proposalRepo, 'Lopez');
    const money = await seedMoney(h.proposalRepo, 'Beta', 5000);

    const lines: string[] = [];
    let cur = await startVoiceBatchApproval(h.deps, call('call-batch'));
    lines.push(cur.speak);
    let state: VoiceApprovalSessionState = { ...cur.sessionState };
    let guard = 0;
    while (cur.pending && guard++ < 20) {
      const stage = cur.pending.stage;
      cur = await continueVoiceBatchApproval(h.deps, {
        ...call('call-batch'),
        sessionState: state,
        utterance: stage === 'confirm' ? 'yes' : '4271',
        pending: cur.pending,
      });
      lines.push(cur.speak);
      state = { ...state, ...cur.sessionState };
    }

    expect(cur.outcome).toBe('batch_complete');
    expect((await h.proposalRepo.findById(TENANT, capture.id))?.status).toBe('approved');
    expect((await h.proposalRepo.findById(TENANT, money.id))?.status).toBe('ready_for_review');
    expect(lines.join(' ')).not.toContain('approval code');
    expect(lines.join(' ')).not.toMatch(/one-tap link/i);
    expect(linkTexts(h)).toEqual([]);
  });
});

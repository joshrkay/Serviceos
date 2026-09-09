/**
 * `ai/voice-turn/inapp-lookup-surface.ts#answerInAppLookup` — the in-app
 * operator voice surface's caller of the shared lookup dispatch.
 *
 * WHAT THIS PINS
 * --------------
 * Before this surface existed, in-app voice intercepted exactly ONE lookup
 * intent (`lookup_day_overview`, via `deps.ownerLookupResolver`) and only for
 * owner sessions. Every other `lookup_*` fell into the drafting FSM and — the
 * lookup family being deliberately absent from `INTENT_TO_PROPOSAL_TYPE` —
 * ended as a `voice_clarification` card nobody could action. "What does Khan
 * owe?" got no answer at all.
 *
 * The four properties that failure violated, one describe block each:
 *   1. a wired lookup reaches the SKILL and speaks the skill's data,
 *   2. ambiguity and a missing/unknown reference ASK rather than guess,
 *   3. the DB-authoritative RBAC gate still refuses (a technician asking for
 *      revenue hears the refusal, never the number),
 *   4. a lookup that cannot run says so honestly — and every outcome,
 *      answered or not, emits `lookup_executed` so a dead lookup is a metric
 *      rather than an audit finding.
 *
 * NO DB, NO LLM: in-memory repos and a stub EntityResolver throughout.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  answerInAppLookup,
  speakForOperator,
} from '../../../src/ai/voice-turn/inapp-lookup-surface';
import { LOOKUP_UNAVAILABLE_LINE } from '../../../src/workers/voice-lookup-answer';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import type {
  VoiceSession,
  VoiceSessionEvent,
} from '../../../src/ai/agents/customer-calling/voice-session-store';
import type { AssistantLookupDeps } from '../../../src/ai/orchestration/lookup-dispatch';
import type { EntityResolver } from '../../../src/ai/resolution/entity-resolver';
import { InMemoryCustomerRepository, createCustomer } from '../../../src/customers/customer';
import { InMemoryProposalRepository } from '../../../src/proposals/proposal';
import { InMemoryMoneyDashboardRepository } from '../../../src/reports/money-dashboard';
import { InMemoryJobRepository } from '../../../src/jobs/job';
import { InMemoryInvoiceRepository } from '../../../src/invoices/invoice';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OPERATOR = 'user-operator';
const NOW = new Date('2026-09-09T16:00:00Z');

/** A session plus a live tap on its event bus (where `lookup_executed` lands). */
function inAppSession(store: VoiceSessionStore, actorUserId: string | undefined) {
  const session: VoiceSession = store.create(TENANT, 'inapp');
  if (actorUserId) session.actorUserId = actorUserId;
  const events: VoiceSessionEvent[] = [];
  session.events.on('voice-event', (e: VoiceSessionEvent) => events.push(e));
  return { session, events };
}

function lookupEvents(events: VoiceSessionEvent[]) {
  return events.filter(
    (e): e is Extract<VoiceSessionEvent, { type: 'lookup_executed' }> =>
      e.type === 'lookup_executed',
  );
}

/** Resolves any reference to one id — the "operator named a real customer" case. */
function resolverTo(id: string, label = 'Priya Khan'): EntityResolver {
  return {
    resolve: vi.fn(async ({ kind }: { kind: string }) => ({
      kind: 'resolved' as const,
      candidate: { id, kind: kind as never, label, score: 0.98 },
    })),
  } as unknown as EntityResolver;
}

/** Two matches — the surface must ASK, never pick. */
function ambiguousResolver(labels: string[]): EntityResolver {
  return {
    resolve: vi.fn(async ({ kind }: { kind: string }) => ({
      kind: 'ambiguous' as const,
      candidates: labels.map((label, i) => ({
        id: `cand-${i}`,
        kind: kind as never,
        label,
        score: 0.85,
      })),
    })),
  } as unknown as EntityResolver;
}

/** No match at all. */
function notFoundResolver(): EntityResolver {
  return {
    resolve: vi.fn(async ({ reference }: { reference: string }) => ({
      kind: 'not_found' as const,
      reference,
    })),
  } as unknown as EntityResolver;
}

/**
 * The lookup skills are shared with the live phone, where the caller IS the
 * customer, so their summaries are second-person. In app the OPERATOR asks
 * about someone else, and "Your account is paid in full" is then addressed to
 * the wrong party AND never says which record answered.
 */
describe('speakForOperator — re-points a customer-scoped summary at the customer', () => {
  const NAME = 'Khan Household';
  const cases: ReadonlyArray<[string, string]> = [
    // The shipped copy, verbatim (ai/i18n/en.ts + skills/lookup-balance.ts).
    [
      'Your account is paid in full — nothing currently owed.',
      "Khan Household's account is paid in full — nothing currently owed.",
    ],
    [
      'You currently owe $488.25 across 2 open invoice(s).',
      'Khan Household currently owes $488.25 across 2 open invoice(s).',
    ],
    [
      'Your current balance is $488.25, due March 3.',
      "Khan Household's current balance is $488.25, due March 3.",
    ],
    ['You have one open invoice — INV-0042.', 'Khan Household has one open invoice — INV-0042.'],
    ['You owe $12.00.', 'Khan Household owes $12.00.'],
    ["You don't have any open estimates.", "Khan Household doesn't have any open estimates."],
    ['You do not have any open estimates.', 'Khan Household does not have any open estimates.'],
    ['Your next appointment is Thursday at 9 AM.', "Khan Household's next appointment is Thursday at 9 AM."],
    ['You still have 2 unsigned agreements.', 'Khan Household still has 2 unsigned agreements.'],
    // Rewrites at SENTENCE starts, so a second sentence is re-pointed too.
    [
      'Your account is current. You have 1 upcoming visit.',
      "Khan Household's account is current. Khan Household has 1 upcoming visit.",
    ],
    // Anything that is not a leading second-person form is left ALONE — these
    // summaries carry money, dates and record numbers.
    ['I have Priya Khan on file.', 'I have Priya Khan on file.'],
    ['No appointments scheduled.', 'No appointments scheduled.'],
    // Mid-sentence "you" is not a leading form and must survive untouched.
    ['The invoice says you owe nothing.', 'The invoice says you owe nothing.'],
  ];

  it.each(cases)('%s', (summary, expected) => {
    expect(speakForOperator(summary, NAME)).toBe(expected);
  });

  it('is a no-op with no customer name (and with a blank one)', () => {
    const summary = 'Your account is paid in full — nothing currently owed.';
    expect(speakForOperator(summary)).toBe(summary);
    expect(speakForOperator(summary, '   ')).toBe(summary);
  });

  it('never expands a `$&` in a tenant-controlled display name', () => {
    expect(speakForOperator('You owe $12.00.', 'A$& Plumbing')).toBe('A$& Plumbing owes $12.00.');
  });
});

describe('answerInAppLookup — a wired lookup speaks the skill\'s own data', () => {
  it('lookup_customer resolves the spoken name and reads the customer back', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    try {
      const customerRepo = new InMemoryCustomerRepository();
      const khan = await createCustomer(
        {
          tenantId: TENANT,
          firstName: 'Priya',
          lastName: 'Khan',
          primaryPhone: '+15551230000',
          createdBy: OPERATOR,
        },
        customerRepo,
      );
      const deps: AssistantLookupDeps = {
        answers: {},
        shared: { customerRepo, proposalRepo: new InMemoryProposalRepository() },
        entityResolver: resolverTo(khan.id),
        now: () => NOW,
      };
      const { session, events } = inAppSession(store, OPERATOR);

      const line = await answerInAppLookup(deps, {
        session,
        tenantId: TENANT,
        userId: session.actorUserId,
        intent: 'lookup_customer',
        entities: { customerName: 'Khan' },
      });

      expect(line.toLowerCase()).toContain('priya khan');
      expect(line).not.toBe(LOOKUP_UNAVAILABLE_LINE);
      const [executed] = lookupEvents(events);
      expect(executed).toMatchObject({
        type: 'lookup_executed',
        skillName: 'lookup_customer',
        success: true,
      });
      expect(executed!.error).toBeUndefined();
    } finally {
      store.dispose();
    }
  });

  it('a customer-scoped answer names the customer instead of saying "your"', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    try {
      const customerRepo = new InMemoryCustomerRepository();
      const khan = await createCustomer(
        { tenantId: TENANT, firstName: 'Priya', lastName: 'Khan', createdBy: OPERATOR },
        customerRepo,
      );
      const deps: AssistantLookupDeps = {
        answers: { invoiceRepo: new InMemoryInvoiceRepository() },
        shared: {
          customerRepo,
          jobRepo: new InMemoryJobRepository(),
          proposalRepo: new InMemoryProposalRepository(),
        },
        entityResolver: resolverTo(khan.id, 'Priya Khan'),
        now: () => NOW,
      };
      const { session, events } = inAppSession(store, OPERATOR);

      const line = await answerInAppLookup(deps, {
        session,
        tenantId: TENANT,
        userId: session.actorUserId,
        intent: 'lookup_balance',
        entities: { customerName: 'Khan' },
      });

      // The skill's own second-person copy is "Your account is paid in full
      // — nothing currently owed."
      expect(line).toBe("Priya Khan's account is paid in full — nothing currently owed.");
      expect(line).not.toMatch(/\byour\b/i);
      expect(lookupEvents(events)).toEqual([expect.objectContaining({ success: true })]);
    } finally {
      store.dispose();
    }
  });

  it('a REFUSAL is never re-pointed at the customer — it is about the asker', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    try {
      const customerRepo = new InMemoryCustomerRepository();
      const khan = await createCustomer(
        { tenantId: TENANT, firstName: 'Priya', lastName: 'Khan', createdBy: OPERATOR },
        customerRepo,
      );
      const deps: AssistantLookupDeps = {
        answers: {
          invoiceRepo: new InMemoryInvoiceRepository(),
          resolveMemberRole: async () => 'technician',
        },
        shared: {
          customerRepo,
          jobRepo: new InMemoryJobRepository(),
          proposalRepo: new InMemoryProposalRepository(),
        },
        entityResolver: resolverTo(khan.id, 'Priya Khan'),
        now: () => NOW,
      };
      const { session } = inAppSession(store, 'user-technician');

      const line = await answerInAppLookup(deps, {
        session,
        tenantId: TENANT,
        userId: session.actorUserId,
        // Customer-scoped in phrasing but `reports:view`-gated: a technician
        // gets the refusal, which speaks about THEIR access, not the customer.
        intent: 'lookup_job_profit',
        entities: { customerName: 'Khan' },
      });

      expect(line).toContain("That's an owner-level report");
      expect(line).not.toContain('Priya Khan');
    } finally {
      store.dispose();
    }
  });
});

describe('answerInAppLookup — ambiguity and missing references ASK, never guess', () => {
  it('an ambiguous customer name speaks the shared which-one line', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    try {
      const deps: AssistantLookupDeps = {
        answers: {},
        shared: {
          customerRepo: new InMemoryCustomerRepository(),
          proposalRepo: new InMemoryProposalRepository(),
        },
        entityResolver: ambiguousResolver(['Priya Khan (555-1230)', 'Sam Khan (555-9876)']),
        now: () => NOW,
      };
      const { session, events } = inAppSession(store, OPERATOR);

      const line = await answerInAppLookup(deps, {
        session,
        tenantId: TENANT,
        userId: session.actorUserId,
        intent: 'lookup_balance',
        entities: { customerName: 'Khan' },
      });

      expect(line).toContain('More than one match for "Khan"');
      expect(line).toContain('Priya Khan (555-1230)');
      expect(line).toContain('Sam Khan (555-9876)');
      expect(line).toMatch(/which one did you mean\?/i);
      // Asking is NOT answering — the metric must not read as a success.
      expect(lookupEvents(events)).toEqual([
        expect.objectContaining({ success: false, error: 'ambiguous_reference' }),
      ]);
    } finally {
      store.dispose();
    }
  });

  it('an unknown customer name is answered honestly, not invented', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    try {
      const deps: AssistantLookupDeps = {
        answers: {},
        shared: {
          customerRepo: new InMemoryCustomerRepository(),
          proposalRepo: new InMemoryProposalRepository(),
        },
        entityResolver: notFoundResolver(),
        now: () => NOW,
      };
      const { session, events } = inAppSession(store, OPERATOR);

      const line = await answerInAppLookup(deps, {
        session,
        tenantId: TENANT,
        userId: session.actorUserId,
        intent: 'lookup_customer',
        entities: { customerName: 'Zzyzx' },
      });

      expect(line).toContain("I couldn't find a customer matching \"Zzyzx\"");
      expect(lookupEvents(events)).toEqual([
        expect.objectContaining({ success: false, error: 'not_found' }),
      ]);
    } finally {
      store.dispose();
    }
  });

  it('a customer-scoped lookup with NO customer reference asks which customer', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    try {
      const deps: AssistantLookupDeps = {
        answers: {},
        shared: {
          customerRepo: new InMemoryCustomerRepository(),
          proposalRepo: new InMemoryProposalRepository(),
        },
        entityResolver: resolverTo('never-used'),
        now: () => NOW,
      };
      const { session, events } = inAppSession(store, OPERATOR);

      const line = await answerInAppLookup(deps, {
        session,
        tenantId: TENANT,
        userId: session.actorUserId,
        intent: 'lookup_balance',
        entities: {},
      });

      expect(line).toContain('Which customer do you mean?');
      expect(lookupEvents(events)).toEqual([
        expect.objectContaining({ success: false, error: 'no_customer_reference' }),
      ]);
    } finally {
      store.dispose();
    }
  });
});

describe('answerInAppLookup — the RBAC gate still refuses, and it fails closed', () => {
  function revenueDeps(role: string | null): AssistantLookupDeps {
    const moneyDashboardRepo = new InMemoryMoneyDashboardRepository();
    moneyDashboardRepo.setSummary({
      month: '2026-09',
      revenueCents: 4_250_00,
      outstandingCents: 90_000,
    } as never);
    return {
      answers: { moneyDashboardRepo, resolveMemberRole: async () => role },
      shared: { proposalRepo: new InMemoryProposalRepository() },
      now: () => NOW,
    };
  }

  it('a technician asking for revenue hears the refusal, never the number', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    try {
      const { session, events } = inAppSession(store, 'user-technician');

      const line = await answerInAppLookup(revenueDeps('technician'), {
        session,
        tenantId: TENANT,
        userId: session.actorUserId,
        intent: 'lookup_revenue',
        entities: {},
      });

      expect(line).toContain("That's an owner-level report");
      expect(line).not.toMatch(/4,?250|\$4/);
      expect(lookupEvents(events)).toEqual([
        expect.objectContaining({ success: false, error: 'refused' }),
      ]);
    } finally {
      store.dispose();
    }
  });

  it('an owner asking for revenue gets the number', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    try {
      const { session, events } = inAppSession(store, OPERATOR);

      const line = await answerInAppLookup(revenueDeps('owner'), {
        session,
        tenantId: TENANT,
        userId: session.actorUserId,
        intent: 'lookup_revenue',
        entities: {},
      });

      expect(line).not.toContain("That's an owner-level report");
      expect(line).toMatch(/4,250|4250/);
      expect(lookupEvents(events)).toEqual([expect.objectContaining({ success: true })]);
    } finally {
      store.dispose();
    }
  });

  it('a session with no actor (harness fixture) is refused, never answered as nobody', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    try {
      const { session, events } = inAppSession(store, undefined);

      const line = await answerInAppLookup(revenueDeps('owner'), {
        session,
        tenantId: TENANT,
        userId: session.actorUserId,
        intent: 'lookup_revenue',
        entities: {},
      });

      expect(line).toContain("That's an owner-level report");
      expect(lookupEvents(events)).toEqual([
        expect.objectContaining({ success: false, error: 'refused' }),
      ]);
    } finally {
      store.dispose();
    }
  });
});

describe('answerInAppLookup — a lookup that cannot run says so, and is still measured', () => {
  it('no lookups bundle wired → the unavailable line + lookup_executed{unsupported}', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    try {
      const { session, events } = inAppSession(store, OPERATOR);

      const line = await answerInAppLookup(undefined, {
        session,
        tenantId: TENANT,
        userId: session.actorUserId,
        intent: 'lookup_jobs',
        entities: { customerName: 'Khan' },
      });

      expect(line).toBe(LOOKUP_UNAVAILABLE_LINE);
      expect(lookupEvents(events)).toEqual([
        expect.objectContaining({ skillName: 'lookup_jobs', success: false, error: 'unsupported' }),
      ]);
    } finally {
      store.dispose();
    }
  });

  it('an intent whose repos are not wired in this deployment degrades the same way', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    try {
      // lookup_jobs needs shared.jobRepo; this deployment has none, so the
      // shared dispatch returns `unsupported` (null) rather than an answer.
      const deps: AssistantLookupDeps = {
        answers: {},
        shared: { proposalRepo: new InMemoryProposalRepository() },
        entityResolver: resolverTo('cust-1'),
        now: () => NOW,
      };
      const { session, events } = inAppSession(store, OPERATOR);

      const line = await answerInAppLookup(deps, {
        session,
        tenantId: TENANT,
        userId: session.actorUserId,
        intent: 'lookup_jobs',
        entities: { customerName: 'Khan' },
      });

      expect(line).toBe(LOOKUP_UNAVAILABLE_LINE);
      expect(lookupEvents(events)).toEqual([
        expect.objectContaining({ success: false, error: 'unsupported' }),
      ]);
    } finally {
      store.dispose();
    }
  });

  it('a skill failure speaks the shared VISIBLE failure copy, not an invention', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    try {
      const customerRepo = new InMemoryCustomerRepository();
      vi.spyOn(customerRepo, 'findById').mockRejectedValue(new Error('pg: connection terminated'));
      const deps: AssistantLookupDeps = {
        answers: {},
        shared: { customerRepo, proposalRepo: new InMemoryProposalRepository() },
        entityResolver: resolverTo('cust-1'),
        now: () => NOW,
      };
      const { session, events } = inAppSession(store, OPERATOR);

      const line = await answerInAppLookup(deps, {
        session,
        tenantId: TENANT,
        userId: session.actorUserId,
        intent: 'lookup_customer',
        entities: { customerName: 'Khan' },
      });

      // The operator is TOLD the lookup failed (one copy, shared with chat)
      // rather than handed a confident-sounding answer assembled from nothing.
      expect(line).toContain('that lookup failed');
      expect(lookupEvents(events)).toEqual([
        expect.objectContaining({ success: false, error: 'failed' }),
      ]);
    } finally {
      store.dispose();
    }
  });

  it('a resolver that throws never escapes the surface', async () => {
    const store = new VoiceSessionStore({ startInterval: false });
    try {
      const deps: AssistantLookupDeps = {
        answers: {},
        shared: {
          customerRepo: new InMemoryCustomerRepository(),
          proposalRepo: new InMemoryProposalRepository(),
        },
        entityResolver: {
          resolve: vi.fn(async () => {
            throw new Error('resolver exploded');
          }),
        } as unknown as EntityResolver,
        now: () => NOW,
      };
      const { session, events } = inAppSession(store, OPERATOR);

      const line = await answerInAppLookup(deps, {
        session,
        tenantId: TENANT,
        userId: session.actorUserId,
        intent: 'lookup_customer',
        entities: { customerName: 'Khan' },
      });

      // The shared dispatch converts its own throw into a visible failure
      // reply — the turn is never dropped and never invented.
      expect(line).toContain('that lookup failed');
      expect(lookupEvents(events)).toEqual([
        expect.objectContaining({ success: false, error: 'failed' }),
      ]);
    } finally {
      store.dispose();
    }
  });
});

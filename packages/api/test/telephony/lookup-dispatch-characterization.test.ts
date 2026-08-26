/**
 * The live-phone lookup path, pinned at the Gather seam (#866 / #843).
 *
 * History: PR #860 wrote this net to pin the OLD behaviour — including the
 * five intents that had no case and the ownerSession-only authorization —
 * so that fixing them "stays a deliberate act". This is that act. The phone
 * is now the third caller of the shared dispatch
 * (`workers/voice-lookup-answer.ts`), authorised by the session's ACTOR.
 *
 * Everything here is observable behaviour: what the caller hears, where the
 * FSM is left, what the session bus saw. Nothing asserts which internal
 * function ran.
 */
import { describe, it, expect, vi } from 'vitest';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { PhoneLookupDeps } from '../../src/ai/voice-turn/phone-lookup-surface';
import {
  CUSTOMER_SCOPED_LOOKUP_INTENTS,
  LOOKUP_REQUIRED_PERMISSION,
} from '../../src/workers/voice-lookup-answer';
import { OWNER_EXTENDED_LOOKUP_INTENT_TYPES } from '../../src/ai/orchestration/intent-classifier';
import type { IntentType } from '../../src/ai/orchestration/intent-classifier';

const tenantId = 'tenant-lk';
// Midday in New York (the skills' default timezone). A wall-clock-relative
// appointment would drop out of "today" for an hour before local midnight.
const FIXED = new Date('2026-08-26T16:00:00.000Z');
// `voiceLookupAnswerSchema` validates `entityRef.id` as a UUID (the phone's
// real customerId/jobId always are), so the stub ids have to be too.
const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const NOT_WIRED = 'I&apos;m having trouble pulling that up right now';
const OWNER_REFUSAL = 'owner-level report';

function gatewayReturning(intentType: string, extractedEntities?: Record<string, unknown>): LLMGateway {
  const response: LLMResponse = {
    content: JSON.stringify({ intentType, confidence: 0.96, ...(extractedEntities ? { extractedEntities } : {}) }),
    model: 'stub',
    provider: 'stub',
    latencyMs: 1,
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  } as unknown as LLMResponse;
  return { complete: vi.fn(async () => response) } as unknown as LLMGateway;
}

type Role = 'owner' | 'dispatcher' | 'technician';

/**
 * A minimal lookups bundle. `answers`/`shared` mirror app.ts's shape; every
 * repo is a vi.fn stub the test controls. `roles` maps actorUserId → role for
 * the shared module's RBAC gate.
 */
function lookups(over: {
  // Deliberately loose: each test wires only the handful of repo METHODS the
  // skill under test actually calls, not whole repository implementations.
  answers?: Record<string, unknown>;
  shared?: Record<string, unknown>;
  roles?: Record<string, Role>;
  entityResolver?: PhoneLookupDeps['entityResolver'];
  /** Fixed clock, for the pins whose answer depends on "today". */
  now?: () => Date;
}): PhoneLookupDeps {
  return {
    answers: {
      resolveMemberRole: async (_t: string, userId: string) => over.roles?.[userId] ?? null,
      ...(over.answers ?? {}),
    } as unknown as PhoneLookupDeps['answers'],
    shared: {
      proposalRepo: { findByTenant: vi.fn(async () => []) },
      ...(over.shared ?? {}),
    } as unknown as PhoneLookupDeps['shared'],
    ...(over.entityResolver ? { entityResolver: over.entityResolver } : {}),
    ...(over.now ? { now: over.now } : {}),
  };
}

function makeAdapter(opts: {
  intentType: string;
  entities?: Record<string, unknown>;
  ownerSession?: boolean;
  actorUserId?: string;
  identified?: boolean;
  lookups?: PhoneLookupDeps;
  deps?: Record<string, unknown>;
}) {
  const store = new VoiceSessionStore({ startInterval: false });
  const adapter = new TwilioGatherAdapter({
    store,
    gateway: gatewayReturning(opts.intentType, opts.entities),
    businessName: 'Acme Plumbing',
    publicBaseUrl: 'https://example.com',
    ...(opts.lookups ? { lookups: opts.lookups } : {}),
    ...(opts.deps ?? {}),
  } as never);
  const callSid = `CA-${opts.intentType}-${opts.actorUserId ?? 'anon'}`;
  const session = store.create(tenantId, 'telephony', {
    callSid,
    ...(opts.ownerSession ? { ownerSession: true, extendedIntents: true } : {}),
  });
  if (opts.actorUserId) session.actorUserId = opts.actorUserId;
  session.machine.dispatch({
    type: 'incoming_call',
    tenantId,
    callSid,
    from: '+15125550111',
    to: '+15125550000',
  });
  session.machine.dispatch({ type: 'greeted_ok' });
  if (opts.identified !== false) {
    session.machine.dispatch({ type: 'caller_known', customerId: CUSTOMER_ID });
    session.customerId = CUSTOMER_ID;
  }
  const events: Array<{ type?: string; success?: boolean; error?: string }> = [];
  session.events.on('voice-event', (e: { type?: string }) => events.push(e));
  return { adapter, session, callSid, events };
}

const ask = (h: ReturnType<typeof makeAdapter>, speech: string) =>
  h.adapter.handleGather({
    sessionId: h.session.id,
    callSid: h.callSid,
    speechResult: speech,
    confidence: 0.95,
    tenantId,
  });

const lookupEvents = (h: ReturnType<typeof makeAdapter>) => h.events.filter((e) => e.type === 'lookup_executed');

describe('phone lookups — the five that were dead on the phone now answer', () => {
  it('lookup_my_day: a technician actor hears THEIR day (self-scoped through the shared dispatch)', async () => {
    const start = new Date(FIXED.getTime() + 60 * 60 * 1000);
    const h = makeAdapter({
      intentType: 'lookup_my_day',
      actorUserId: 'clerk-tech',
      lookups: lookups({
        roles: { 'clerk-tech': 'technician' },
        now: () => FIXED,
        shared: {
          appointmentRepo: {
            findByDateRange: vi.fn(async () => [
              { id: 'a1', tenantId, jobId: 'job-1', scheduledStart: start, scheduledEnd: new Date(start.getTime() + 3_600_000), status: 'scheduled' },
            ]),
          },
          jobRepo: {
            findByIds: vi.fn(async () => [{ id: 'job-1', tenantId, summary: 'Main drain repair', assignedTechnicianId: 'u-tech' }]),
          },
          userRepo: {
            findByTenant: vi.fn(async () => [{ id: 'u-tech', tenantId, clerkUserId: 'clerk-tech', role: 'technician' }]),
          },
        },
      }),
    });

    const xml = await ask(h, "what's my day look like");

    expect(xml).not.toContain(NOT_WIRED);
    expect(xml).toContain('Main drain repair');
    expect(h.session.machine.currentState).toBe('intent_capture');
    expect(xml).toContain('Anything else');
  });

  it('lookup_materials: any resolved actor hears the pending shopping list', async () => {
    const listPending = vi.fn(async () => [
      { id: 'm1', tenantId, description: '3/4 inch copper elbows', quantity: 6, status: 'pending', createdBy: 'u1', createdAt: new Date(), updatedAt: new Date() },
    ]);
    const h = makeAdapter({
      intentType: 'lookup_materials',
      actorUserId: 'clerk-tech',
      lookups: lookups({ roles: { 'clerk-tech': 'technician' }, answers: { materialItemRepo: { listPending } as never } }),
    });

    const xml = await ask(h, 'what materials do I need');

    expect(listPending).toHaveBeenCalled();
    expect(xml).toContain('copper elbows');
  });

  it('lookup_job_profit: an owner naming a job hears the margin', async () => {
    const findById = vi.fn(async () => ({ id: JOB_ID, tenantId, summary: 'Miller water heater', status: 'completed' }));
    const h = makeAdapter({
      intentType: 'lookup_job_profit',
      entities: { jobReference: 'the Miller job' },
      actorUserId: 'clerk-owner',
      lookups: lookups({
        roles: { 'clerk-owner': 'owner' },
        entityResolver: { resolve: vi.fn(async () => ({ kind: 'resolved', candidate: { id: JOB_ID, kind: 'job', label: 'Miller water heater', score: 0.99 } })) } as never,
        shared: { jobRepo: { findById, findByIds: vi.fn(async () => []) } },
        answers: {
          settingsRepo: { findByTenant: vi.fn(async () => ({ tenantId, laborRateCentsPerHour: 8500 })) } as never,
          invoiceRepo: { findByJob: vi.fn(async () => [{ id: 'inv-1', jobId: JOB_ID, status: 'paid', totals: { totalCents: 120000 }, amountPaidCents: 120000, amountDueCents: 0 }]) } as never,
          timeEntryRepo: { findByJob: vi.fn(async () => []) } as never,
          // getJobProfit reads job expenses through the TENANT list with a
          // jobId filter (jobs/job-profit.ts) — there is no findByJob here.
          expenseRepo: { findByTenant: vi.fn(async () => []) } as never,
        },
      }),
    });

    const xml = await ask(h, 'did I make money on the Miller job');

    expect(findById).toHaveBeenCalledWith(tenantId, JOB_ID);
    expect(xml).not.toContain(NOT_WIRED);
    expect(xml).not.toContain(OWNER_REFUSAL);
  });

  it.each(['lookup_crew_schedule', 'lookup_timesheets'])(
    '%s: a dispatcher actor is answered (reports:view) — the flag-era ownerSession gate is gone',
    async (intentType) => {
      const h = makeAdapter({
        intentType,
        actorUserId: 'clerk-dispatch',
        lookups: lookups({
          roles: { 'clerk-dispatch': 'dispatcher' },
          shared: {
            appointmentRepo: { findByDateRange: vi.fn(async () => []) },
            jobRepo: { findByIds: vi.fn(async () => []) },
            userRepo: { findByTenant: vi.fn(async () => []) },
          },
          answers: {
            // TimeEntryService.weeklyHoursByUser reads the WEEK window off
            // findByTenant — the only primitive lookup_timesheets touches.
            timeEntryRepo: { findByTenant: vi.fn(async () => []) } as never,
          },
        }),
      });

      const xml = await ask(h, 'tell me about the crew');

      expect(xml).not.toContain(NOT_WIRED);
      expect(xml).not.toContain(OWNER_REFUSAL);
      // The skills' real empty-state copy — proof a DATA answer was spoken,
      // not merely the absence of a refusal.
      expect(xml).toContain(
        intentType === 'lookup_crew_schedule'
          ? 'crew members on the roster'
          : 'Nobody logged any hours this week',
      );
      expect(h.session.machine.currentState).toBe('intent_capture');
    },
  );
});

describe('phone lookups — authorization is the actor\'s DB role, not the caller-ID boolean', () => {
  it('a technician asking for revenue hears the owner-level refusal, and no repo is read', async () => {
    const query = vi.fn();
    const h = makeAdapter({
      intentType: 'lookup_revenue',
      actorUserId: 'clerk-tech',
      lookups: lookups({ roles: { 'clerk-tech': 'technician' }, answers: { moneyDashboardRepo: { query } as never } }),
    });

    const xml = await ask(h, 'how much did we make this month');

    expect(xml).toContain(OWNER_REFUSAL);
    expect(query).not.toHaveBeenCalled();
  });

  it('an identified CUSTOMER (no actor) asking for revenue is refused — the defence-in-depth gap from #866', async () => {
    const h = makeAdapter({
      intentType: 'lookup_revenue',
      lookups: lookups({ answers: { moneyDashboardRepo: { query: vi.fn() } as never } }),
    });

    const xml = await ask(h, 'how much money did you make this month');

    expect(xml).toContain(OWNER_REFUSAL);
  });

  it('an identified customer asking for the lead pipeline is refused honestly', async () => {
    const h = makeAdapter({
      intentType: 'lookup_leads',
      lookups: lookups({ answers: { leadRepo: { findByTenant: vi.fn(async () => []) } as never } }),
    });

    const xml = await ask(h, 'what leads do you have');

    expect(xml).toContain('couldn&apos;t verify your access to the lead pipeline');
  });

  it('an owner actor on a session with the tenant flag OFF is still answered — the flag gates classification, not dispatch', async () => {
    const digestDate = new Date().toISOString().slice(0, 10);
    const findLatest = vi.fn(async () => ({
      tenantId,
      digestDate,
      payload: {},
      narrative: 'Owner digest: revenue was strong',
    }));
    const h = makeAdapter({
      intentType: 'lookup_digest',
      ownerSession: false,
      actorUserId: 'clerk-owner',
      lookups: lookups({
        roles: { 'clerk-owner': 'owner' },
        answers: {
          // lookup-digest.ts asks for TODAY first, then falls back to the
          // latest stored digest — both primitives must exist.
          dailyDigestRepo: {
            findByTenantAndDate: vi.fn(async () => null),
            findLatest,
          } as never,
        },
      }),
    });

    const xml = await ask(h, 'read me my digest');

    expect(findLatest).toHaveBeenCalled();
    expect(xml).toContain('Owner digest');
  });

  it('lookup_day_overview with NO actor is refused — "never enabled for anonymous customers" holds at DISPATCH, not just classification', async () => {
    // The classifier's tenant flag decides whether an owner-extended intent
    // is OFFERED; on the phone — the only surface with customer callers —
    // dispatch refuses one without a resolved actor too. `lookup_day_overview`
    // has no LOOKUP_REQUIRED_PERMISSION entry, so the shared RBAC gate would
    // otherwise read out the tenant's day to whoever called in.
    const findByDateRange = vi.fn(async () => []);
    const h = makeAdapter({
      intentType: 'lookup_day_overview',
      lookups: lookups({ shared: { appointmentRepo: { findByDateRange }, jobRepo: { findByTenant: vi.fn(async () => []) } } }),
    });

    const xml = await ask(h, "what's on for today");

    expect(xml).toContain(OWNER_REFUSAL);
    expect(findByDateRange).not.toHaveBeenCalled();
  });

  it('lookup_day_overview still has NO permission entry — a technician ACTOR is answered, exactly as on memo and chat', async () => {
    const h = makeAdapter({
      intentType: 'lookup_day_overview',
      actorUserId: 'clerk-tech',
      lookups: lookups({
        roles: { 'clerk-tech': 'technician' },
        shared: {
          appointmentRepo: { findByDateRange: vi.fn(async () => []) },
          jobRepo: { findByTenant: vi.fn(async () => []) },
          proposalRepo: { findByTenant: vi.fn(async () => []), findByStatus: vi.fn(async () => []) },
        },
      }),
    });

    const xml = await ask(h, "what's on for today");

    expect(xml).not.toContain(OWNER_REFUSAL);
    expect(xml).toContain('Your day is clear');
  });

  it('lookup_materials with NO actor is refused — the shopping list is not customer-facing', async () => {
    // lookup_materials sits in the BASE classifier prompt and carries no
    // LOOKUP_REQUIRED_PERMISSION entry (any signed-in operator may hear it on
    // memo/chat), so nothing upstream stopped an identified CUSTOMER from
    // hearing the tenant's shopping list here.
    const listPending = vi.fn(async () => []);
    const h = makeAdapter({
      intentType: 'lookup_materials',
      lookups: lookups({ answers: { materialItemRepo: { listPending } as never } }),
    });

    const xml = await ask(h, 'what materials do we need');

    expect(xml).toContain(OWNER_REFUSAL);
    expect(listPending).not.toHaveBeenCalled();
  });

  it('lookup_my_day with NO actor says so honestly — an identity outcome, not an authorization one', async () => {
    const findByDateRange = vi.fn(async () => []);
    const h = makeAdapter({
      intentType: 'lookup_my_day',
      lookups: lookups({
        shared: {
          appointmentRepo: { findByDateRange },
          jobRepo: { findByIds: vi.fn(async () => []) },
          userRepo: { findByTenant: vi.fn(async () => []) },
        },
      }),
    });

    const xml = await ask(h, "what's my day look like");

    expect(xml).toContain('couldn&apos;t match your number');
    expect(findByDateRange).not.toHaveBeenCalled();
  });

  it('a customer\'s own balance / invoices / appointments keep answering exactly as before', async () => {
    const findByCustomer = vi.fn(async () => []);
    const h = makeAdapter({
      intentType: 'lookup_jobs',
      lookups: lookups({ shared: { jobRepo: { findByCustomer, findById: vi.fn(async () => null) }, appointmentRepo: { findByCustomer: vi.fn(async () => []) } } }),
    });

    const xml = await ask(h, 'what jobs do I have open');

    // lookup-jobs.ts passes its own paging options as a third argument.
    expect(findByCustomer).toHaveBeenCalledWith(tenantId, CUSTOMER_ID, expect.anything());
    expect(xml).not.toContain(NOT_WIRED);
    expect(xml).toContain('Anything else');
  });
});

describe('phone lookups — the contract that must not move', () => {
  it('an unidentified caller never reaches a lookup — identification intercepts first', async () => {
    const findByCustomer = vi.fn(async () => []);
    const h = makeAdapter({
      intentType: 'lookup_jobs',
      identified: false,
      lookups: lookups({ shared: { jobRepo: { findByCustomer } } }),
    });

    await ask(h, 'what jobs do I have');

    expect(h.session.machine.currentState).toBe('identifying');
    expect(findByCustomer).not.toHaveBeenCalled();
  });

  it('a lookup never advances the FSM — pinned on an ANSWERED lookup, not a fallback', async () => {
    const h = makeAdapter({
      intentType: 'lookup_invoices',
      lookups: lookups({
        shared: { jobRepo: { findByCustomer: vi.fn(async () => []) } },
        answers: { invoiceRepo: { findByCustomer: vi.fn(async () => []), findByTenant: vi.fn(async () => []) } as never },
      }),
    });

    const xml = await ask(h, 'what do I owe');

    expect(xml).not.toContain(NOT_WIRED);
    expect(h.session.machine.currentState).toBe('intent_capture');
  });

  it('every outcome is a metric — lookup_executed rides the session bus', async () => {
    const h = makeAdapter({
      intentType: 'lookup_jobs',
      lookups: lookups({ shared: { jobRepo: { findByCustomer: vi.fn(async () => []), findById: vi.fn(async () => null) } } }),
    });

    await ask(h, 'what jobs do I have open');

    expect(lookupEvents(h)).toHaveLength(1);
  });

  it('a deployment with no lookups bundle speaks the unavailable line (never a 5xx)', async () => {
    const h = makeAdapter({ intentType: 'lookup_invoices' });

    const xml = await ask(h, 'what do I owe');

    expect(xml).toContain(NOT_WIRED);
  });
});

describe('phone lookups — spoken reference resolution (shared resolver, chat semantics)', () => {
  it('an ambiguous job reference asks "which one?" listing the candidates, and stays in intent_capture', async () => {
    const h = makeAdapter({
      intentType: 'lookup_job_profit',
      entities: { jobReference: 'the Miller job' },
      actorUserId: 'clerk-owner',
      lookups: lookups({
        roles: { 'clerk-owner': 'owner' },
        entityResolver: {
          resolve: vi.fn(async () => ({
            kind: 'ambiguous',
            candidates: [
              { id: 'j1', kind: 'job', label: 'Miller — Oak Street water heater', score: 0.8 },
              { id: 'j2', kind: 'job', label: 'Miller — 5th Ave furnace', score: 0.79 },
            ],
          })),
        } as never,
        shared: { jobRepo: { findById: vi.fn(), findByIds: vi.fn(async () => []) } },
        answers: {
          settingsRepo: { findByTenant: vi.fn(async () => ({ tenantId })) } as never,
          invoiceRepo: { findByJob: vi.fn(async () => []) } as never,
          timeEntryRepo: { findByJob: vi.fn(async () => []) } as never,
          expenseRepo: { findByTenant: vi.fn(async () => []) } as never,
        },
      }),
    });

    const xml = await ask(h, 'did I make money on the Miller job');

    expect(xml).toContain('More than one match for &quot;the Miller job&quot;');
    expect(xml).toContain('Oak Street');
    expect(xml).toContain('5th Ave');
    expect(h.session.machine.currentState).toBe('intent_capture');
    expect(lookupEvents(h)).toEqual([expect.objectContaining({ success: false, error: 'ambiguous_reference' })]);
  });

  it('a crew-member reference the resolver cannot find speaks the shared not-found copy', async () => {
    const h = makeAdapter({
      intentType: 'lookup_crew_schedule',
      entities: { targetTechnicianName: 'Jake' },
      actorUserId: 'clerk-owner',
      lookups: lookups({
        roles: { 'clerk-owner': 'owner' },
        entityResolver: { resolve: vi.fn(async () => ({ kind: 'not_found', reference: 'Jake' })) } as never,
        shared: {
          appointmentRepo: { findByDateRange: vi.fn(async () => []) },
          jobRepo: { findByIds: vi.fn(async () => []) },
          userRepo: { findByTenant: vi.fn(async () => []) },
        },
      }),
    });

    const xml = await ask(h, "what's Jake doing Thursday");

    expect(xml).toContain('couldn&apos;t find a crew member matching &quot;Jake&quot;');
  });

  it('a technician name on lookup_my_day is IGNORED (not a TECHNICIAN_REF intent) — the speaker is always self', async () => {
    const resolve = vi.fn();
    const h = makeAdapter({
      intentType: 'lookup_my_day',
      entities: { targetTechnicianName: 'Jake' },
      actorUserId: 'clerk-tech',
      lookups: lookups({
        roles: { 'clerk-tech': 'technician' },
        entityResolver: { resolve } as never,
        shared: {
          appointmentRepo: { findByDateRange: vi.fn(async () => []) },
          jobRepo: { findByIds: vi.fn(async () => []) },
          userRepo: { findByTenant: vi.fn(async () => [{ id: 'u-tech', tenantId, clerkUserId: 'clerk-tech', role: 'technician' }]) },
        },
      }),
    });

    await ask(h, "what's my day look like");

    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('phone lookups — every outcome is a lookup_executed event', () => {
  it('answered → success: true', async () => {
    const h = makeAdapter({
      intentType: 'lookup_jobs',
      lookups: lookups({ shared: { jobRepo: { findByCustomer: vi.fn(async () => []), findById: vi.fn(async () => null) }, appointmentRepo: { findByCustomer: vi.fn(async () => []) } } }),
    });
    await ask(h, 'what jobs do I have');
    expect(lookupEvents(h)).toEqual([expect.objectContaining({ skillName: 'lookup_jobs', success: true })]);
  });

  it('refused → success: false, error: refused', async () => {
    const h = makeAdapter({ intentType: 'lookup_revenue', lookups: lookups({ answers: { moneyDashboardRepo: {} as never } }) });
    await ask(h, 'revenue');
    expect(lookupEvents(h)).toEqual([expect.objectContaining({ skillName: 'lookup_revenue', success: false, error: 'refused' })]);
  });

  it('skill failure → success: false with the error, and the unavailable line', async () => {
    const h = makeAdapter({
      intentType: 'lookup_jobs',
      lookups: lookups({ shared: { jobRepo: { findByCustomer: vi.fn(async () => { throw new Error('pg down'); }), findById: vi.fn() }, appointmentRepo: {} } }),
    });
    const xml = await ask(h, 'what jobs do I have');
    expect(xml).toContain(NOT_WIRED);
    expect(lookupEvents(h)).toEqual([expect.objectContaining({ success: false, error: 'pg down' })]);
  });

  it('unsupported (repos missing in this deployment) → success: false, error: unsupported, and a warning naming the intent', async () => {
    const h = makeAdapter({ intentType: 'lookup_materials', actorUserId: 'clerk-tech', lookups: lookups({ roles: { 'clerk-tech': 'technician' } }) });

    // The JSON logger writes directly to process.stdout — not console.* — so
    // spy on stdout.write to capture the wiring-gap warning line. (Same
    // mechanism as test/routes/telephony-tenant-lookup.test.ts.)
    const stdoutChunks: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    let xml: string;
    try {
      xml = await ask(h, 'what materials do I need');
    } finally {
      stdoutSpy.mockRestore();
    }

    expect(xml).toContain(NOT_WIRED);
    expect(lookupEvents(h)).toEqual([expect.objectContaining({ skillName: 'lookup_materials', success: false, error: 'unsupported' })]);

    const warnings = stdoutChunks
      .flatMap((c) => c.split('\n'))
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as { level?: string; message?: string; intent?: string })
      .filter((e) => e.level === 'warn' && (e.message ?? '').includes('unsupported'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0].intent).toBe('lookup_materials');
  });
});

/**
 * The default-deny net.
 *
 * Two intents reached data with no actor because they carry no permission
 * entry BY DESIGN (`lookup_day_overview`, `lookup_materials` — any signed-in
 * operator may hear them on memo/chat). The phone is the one surface whose
 * caller may be a customer, so the rule here is an ALLOWLIST: with no actor
 * you get your OWN records and tenant-public lookups, nothing else. This
 * table walks the whole taxonomy so intent 21 cannot slip through silently.
 */
const ALL_LOOKUP_INTENTS: IntentType[] = Array.from(
  new Set<IntentType>([
    ...CUSTOMER_SCOPED_LOOKUP_INTENTS,
    ...LOOKUP_REQUIRED_PERMISSION.keys(),
    ...OWNER_EXTENDED_LOOKUP_INTENT_TYPES,
    'lookup_my_day',
    'lookup_materials',
    'lookup_availability',
  ]),
);

/** Tenant-public: a customer may legitimately ask when you could come out. */
const PHONE_PUBLIC: IntentType[] = ['lookup_availability'];

const MUST_REFUSE_WITHOUT_ACTOR = ALL_LOOKUP_INTENTS.filter(
  (i) => !CUSTOMER_SCOPED_LOOKUP_INTENTS.has(i) && !PHONE_PUBLIC.includes(i),
);

/** Every repo method any lookup skill can reach, as a call-recording stub. */
function trackedRepos() {
  const called: string[] = [];
  const method = (label: string) =>
    vi.fn(async () => {
      called.push(label);
      return [] as never[];
    });
  const repo = (label: string, methods: string[]) =>
    Object.fromEntries(methods.map((k) => [k, method(`${label}.${k}`)]));
  return {
    called,
    answers: {
      invoiceRepo: repo('invoiceRepo', ['findByTenant', 'findByJob', 'findByCustomer']),
      estimateRepo: repo('estimateRepo', ['findByTenant', 'findByJob']),
      agreementRepo: repo('agreementRepo', ['findByCustomer', 'findByTenant']),
      moneyDashboardRepo: repo('moneyDashboardRepo', ['query']),
      dailyDigestRepo: repo('dailyDigestRepo', ['findByTenantAndDate', 'findLatest']),
      dunningConfigRepo: repo('dunningConfigRepo', ['findByTenant']),
      droppedCallRecoveryRepo: repo('droppedCallRecoveryRepo', ['listUnansweredRecoveries']),
      timeEntryRepo: repo('timeEntryRepo', ['findByTenant', 'findByJob', 'findByUser']),
      expenseRepo: repo('expenseRepo', ['findByTenant']),
      leadRepo: repo('leadRepo', ['findByTenant']),
      catalogRepo: repo('catalogRepo', ['listByTenant']),
      settingsRepo: repo('settingsRepo', ['findByTenant']),
      materialItemRepo: repo('materialItemRepo', ['listPending']),
    },
    shared: {
      jobRepo: repo('jobRepo', ['findByCustomer', 'findById', 'findByIds', 'findByTenant']),
      appointmentRepo: repo('appointmentRepo', ['findByCustomer', 'findByDateRange']),
      customerRepo: repo('customerRepo', ['findById', 'findByTenant']),
      proposalRepo: repo('proposalRepo', ['findByTenant', 'findByStatus']),
      userRepo: repo('userRepo', ['findByTenant']),
    },
  };
}

/** The honest refusals — never data. */
const REFUSAL_COPY: Partial<Record<string, string>> = {
  lookup_catalog: 'office-level view',
  lookup_leads: 'couldn&apos;t verify your access',
  lookup_my_day: 'couldn&apos;t match your number',
};

describe('phone lookups — with no actor, default-deny across the whole taxonomy', () => {
  it('the taxonomy this net covers is exactly 20 intents (intent 21 must fail here)', () => {
    expect(ALL_LOOKUP_INTENTS).toHaveLength(20);
  });

  it.each(MUST_REFUSE_WITHOUT_ACTOR)(
    '%s is refused to a caller with no actor, and reads NO repo',
    async (intent) => {
      const repos = trackedRepos();
      const h = makeAdapter({
        intentType: intent,
        lookups: lookups({ answers: repos.answers, shared: repos.shared }),
      });

      const xml = await ask(h, 'tell me about that');

      expect(xml).toContain(REFUSAL_COPY[intent] ?? OWNER_REFUSAL);
      expect(repos.called).toEqual([]);
    },
  );
});

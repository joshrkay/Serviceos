/**
 * Full-app voice coverage — task handlers + execution for the new
 * update_customer / log_expense / convert_lead intents.
 *
 * These mirror the existing voice-extended-tasks pattern: the handler
 * is a passthrough from the classifier's ExtractedEntities to a typed
 * proposal payload, flagging missing fields so a partial payload can
 * never auto-execute.
 */
import { describe, it, expect } from 'vitest';
import {
  UpdateCustomerTaskHandler,
  LogExpenseTaskHandler,
  ConvertLeadTaskHandler,
  ConfirmAppointmentTaskHandler,
  MarkLeadLostTaskHandler,
  AddServiceLocationTaskHandler,
  LogTimeEntryTaskHandler,
  NotifyDelayTaskHandler,
  RequestFeedbackTaskHandler,
  RecordPaymentTaskHandler,
  RescheduleAppointmentTaskHandler,
  CancelAppointmentTaskHandler,
  DEFAULT_MILEAGE_RATE_CENTS_PER_MILE,
  MAX_MILEAGE_MILES,
} from '../../../src/ai/tasks/voice-extended-tasks';
import type { AppointmentRepository } from '../../../src/appointments/appointment';
import type { JobRepository } from '../../../src/jobs/job';
import { TaskContext } from '../../../src/ai/tasks/task-handlers';
import { ConvertLeadExecutionHandler } from '../../../src/proposals/execution/convert-lead-handler';
import { NotifyDelayExecutionHandler } from '../../../src/proposals/execution/full-app-voice-handlers';
import { Proposal, ProposalType, missingFieldsFor } from '../../../src/proposals/proposal';
import { InMemoryLeadRepository } from '../../../src/leads/lead';
import { InMemoryCustomerRepository } from '../../../src/customers/customer';
import { InMemoryLocationRepository } from '../../../src/locations/location';
import { createLead } from '../../../src/leads/lead-service';

function ctx(overrides: Partial<TaskContext>): TaskContext {
  return {
    tenantId: 't-1',
    userId: 'u-1',
    message: 'test transcript',
    ...overrides,
  };
}

describe('UpdateCustomerTaskHandler', () => {
  it('uses the identified caller id and maps updated fields onto the payload', async () => {
    const res = await new UpdateCustomerTaskHandler().handle(
      ctx({
        customerId: 'cust-9',
        existingEntities: { updatedPhone: '+15555550143' },
      }),
    );
    expect(res.proposal.proposalType).toBe('update_customer');
    expect(res.proposal.payload.customerId).toBe('cust-9');
    expect(res.proposal.payload.phone).toBe('+15555550143');
    expect(missingFieldsFor(res.proposal)).not.toContain('customerId');
  });

  it('flags customerId missing on the operator path (no caller identity)', async () => {
    const res = await new UpdateCustomerTaskHandler().handle(
      ctx({ existingEntities: { customerName: 'Sarah', updatedEmail: 'a@b.co' } }),
    );
    expect(res.proposal.payload.customerReference).toBe('Sarah');
    expect(missingFieldsFor(res.proposal)).toContain('customerId');
  });

  it('flags an absent change as a missing updatedField', async () => {
    const res = await new UpdateCustomerTaskHandler().handle(
      ctx({ customerId: 'cust-9', existingEntities: {} }),
    );
    expect(missingFieldsFor(res.proposal)).toContain('updatedField');
  });
});

describe('LogExpenseTaskHandler', () => {
  it('maps amount, category and vendor; defaults spentAt to today', async () => {
    const res = await new LogExpenseTaskHandler().handle(
      ctx({
        existingEntities: {
          amount: 24000,
          expenseCategory: 'materials',
          vendor: 'Supply House',
          expenseDescription: 'water heater parts',
        },
      }),
    );
    expect(res.proposal.proposalType).toBe('log_expense');
    expect(res.proposal.payload.amountCents).toBe(24000);
    expect(res.proposal.payload.category).toBe('materials');
    expect(res.proposal.payload.vendor).toBe('Supply House');
    // Quality-review fix (I3) — spentAt is now a full ISO instant (tenant
    // midnight, via tzMidnight), not a bare 'YYYY-MM-DD' string: the
    // execution handler's `new Date(spentAtRaw)` reads a date-only string
    // as UTC midnight, silently rendering back a day early in any tenant
    // west of UTC. Applies to the plain log_expense path too, not just
    // log_mileage — same flaw, same fix.
    expect(res.proposal.payload.spentAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(missingFieldsFor(res.proposal)).not.toContain('amountCents');
  });

  it('flags amountCents missing and defaults category to other', async () => {
    const res = await new LogExpenseTaskHandler().handle(
      ctx({ existingEntities: {} }),
    );
    expect(res.proposal.payload.category).toBe('other');
    expect(missingFieldsFor(res.proposal)).toContain('amountCents');
  });

  // U3 (B7.8) — log_expense joined JOB_REF_INTENTS: the router's entity
  // resolver resolves "the Henderson job" pre-draft and the verified jobId
  // rides existingEntities.jobId. The handler links the expense to it; an
  // unresolved/absent reference still logs UNLINKED (no new gate). P-44: the
  // linked case is proven by the EXECUTED EFFECT — the persisted expense row
  // carries the jobId job P&L aggregates by.
  describe('U3: spoken expense keeps its job link', () => {
    const JOB_ID = '77777777-7777-4777-8777-777777777777';

    it('resolver-verified jobId lands on the payload and the PERSISTED expense row (executed effect)', async () => {
      const res = await new LogExpenseTaskHandler().handle(
        ctx({
          existingEntities: {
            amount: 4000,
            expenseCategory: 'materials',
            expenseDescription: 'parts for the Henderson job',
            jobReference: 'the Henderson job',
            jobId: JOB_ID,
          },
        }),
      );
      expect(res.proposal.payload.jobId).toBe(JOB_ID);
      expect(res.proposal.payload.jobReference).toBe('the Henderson job');
      expect(res.proposal.payload.amountCents).toBe(4000);
      expect(missingFieldsFor(res.proposal)).toEqual([]);

      const { InMemoryExpenseRepository } = await import('../../../src/expenses/expense');
      const { LogExpenseExecutionHandler } = await import(
        '../../../src/proposals/execution/log-expense-handler'
      );
      const expenseRepo = new InMemoryExpenseRepository();
      const exec = await new LogExpenseExecutionHandler(expenseRepo).execute(res.proposal, {
        tenantId: 't-1',
        executedBy: 'u-1',
      });
      expect(exec.success).toBe(true);

      // The job-P&L aggregation reads findByTenant(tenantId, { jobId }) —
      // exactly this filter must return the spoken expense.
      const linked = await expenseRepo.findByTenant('t-1', { jobId: JOB_ID });
      expect(linked).toHaveLength(1);
      expect(linked[0].amountCents).toBe(4000);
      expect(linked[0].jobId).toBe(JOB_ID);
    });

    it('no job mention → logs unlinked exactly as before (no gate, no jobId)', async () => {
      const res = await new LogExpenseTaskHandler().handle(
        ctx({ existingEntities: { amount: 4000, expenseCategory: 'materials' } }),
      );
      expect(res.proposal.payload.jobId).toBeUndefined();
      expect(missingFieldsFor(res.proposal)).toEqual([]);
    });

    it('a non-UUID value in the jobId seam never links (shape check, no silent guess)', async () => {
      const res = await new LogExpenseTaskHandler().handle(
        ctx({
          existingEntities: {
            amount: 4000,
            jobReference: 'the Henderson job',
            jobId: 'the Henderson job',
          },
        }),
      );
      expect(res.proposal.payload.jobId).toBeUndefined();
      // Still no gate — the expense logs unlinked rather than stalling.
      expect(missingFieldsFor(res.proposal)).toEqual([]);
    });
  });

  // Task 11 (2026-08-07 tradesperson plan) — log_mileage is an ALIAS intent
  // onto this SAME handler/proposal type. Quality-review fix (2026-08-09):
  // the branch keys on `context.intent === 'log_mileage'` (TaskContext.intent
  // — ai/tasks/task-handlers.ts), NOT the presence of `mileageMiles`. The
  // classifier's JSON template is a single GLOBAL shape shared by every
  // intent (entitiesForProposal, workers/voice-action-router.ts, is a
  // passthrough for every intent except create_customer) — nothing stops a
  // real LLM from also populating `mileageMiles` on a log_expense turn, or
  // `amount` on a log_mileage turn. Keying on field presence let either
  // stray field hijack or get hijacked; keying on the classified intent
  // cannot.
  describe('Task 11: log_mileage alias (mileageMiles → amountCents, category: vehicle)', () => {
    it('converts a spoken mileage count at the IRS rate; spentAt is TODAY in the TENANT timezone', async () => {
      // 11:30pm America/New_York on 2026-06-11 is already 2026-06-12 in UTC —
      // pins that spentAt is computed from the TENANT-LOCAL calendar date,
      // never a raw `new Date().toISOString()` UTC slice (Task 7's lesson),
      // AND that the stored value is a full ISO instant representing tenant
      // midnight (tzMidnight) rather than a bare 'YYYY-MM-DD' string —
      // LogExpenseExecutionHandler's `new Date(spentAtRaw)` reads a bare
      // date-only string as UTC midnight, which re-introduces the exact
      // off-by-one this fix exists to eliminate once rendered back in a
      // western tenant's own timezone.
      const now = new Date('2026-06-12T03:30:00.000Z');
      const res = await new LogExpenseTaskHandler().handle(
        ctx({
          intent: 'log_mileage',
          timezone: 'America/New_York',
          now,
          existingEntities: { mileageMiles: 32, jobReference: 'the Patel job' },
        }),
      );
      expect(res.proposal.proposalType).toBe('log_expense');
      expect(res.proposal.payload.category).toBe('vehicle');
      expect(res.proposal.payload.amountCents).toBe(32 * DEFAULT_MILEAGE_RATE_CENTS_PER_MILE);
      expect(res.proposal.payload.amountCents).toBe(2240);
      expect(res.proposal.payload.description).toBe('Mileage — 32 miles');
      // Midnight America/New_York (EDT, UTC-4) on 2026-06-11 is 04:00 UTC.
      expect(res.proposal.payload.spentAt).toBe('2026-06-11T04:00:00.000Z');
      expect(res.proposal.payload.jobReference).toBe('the Patel job');
      expect(missingFieldsFor(res.proposal)).toEqual([]);
    });

    it('rounds a fractional mileage count to the nearest cent', async () => {
      const res = await new LogExpenseTaskHandler().handle(
        ctx({ intent: 'log_mileage', existingEntities: { mileageMiles: 4.37 } }),
      );
      // 4.37 * 70 = 305.9 -> rounds to 306.
      expect(res.proposal.payload.amountCents).toBe(306);
      expect(res.proposal.payload.description).toBe('Mileage — 4.37 miles');
    });

    it('gates on amountCents when no mileage is stated at all', async () => {
      const res = await new LogExpenseTaskHandler().handle(
        ctx({ intent: 'log_mileage', existingEntities: {} }),
      );
      expect(missingFieldsFor(res.proposal)).toContain('amountCents');
      expect(res.proposal.payload.amountCents).toBeUndefined();
      expect(res.proposal.payload.category).toBe('vehicle');
    });

    it('gates on amountCents for zero miles (a degenerate, nothing-to-log value)', async () => {
      const res = await new LogExpenseTaskHandler().handle(
        ctx({ intent: 'log_mileage', existingEntities: { mileageMiles: 0 } }),
      );
      expect(missingFieldsFor(res.proposal)).toContain('amountCents');
      expect(res.proposal.payload.amountCents).toBeUndefined();
    });

    it('gates on amountCents for negative miles', async () => {
      const res = await new LogExpenseTaskHandler().handle(
        ctx({ intent: 'log_mileage', existingEntities: { mileageMiles: -5 } }),
      );
      expect(missingFieldsFor(res.proposal)).toContain('amountCents');
      expect(res.proposal.payload.amountCents).toBeUndefined();
    });

    // M1 (quality review) — the gate must be on the COMPUTED CENTS, not the
    // raw miles: any 0 < miles < 1/140 (~0.00714) rounds to 0 cents, which
    // would otherwise pass a bare `miles > 0` check and violate the
    // contract's `amountCents.positive()` (and the DB CHECK) downstream —
    // approved-then-fails-at-execution, the exact drift class
    // voice-payload-contract.test.ts exists to catch.
    it('gates on amountCents when a genuinely positive mileage figure still rounds to zero cents', async () => {
      // 0.005 * 70 = 0.35 -> rounds to 0.
      const res = await new LogExpenseTaskHandler().handle(
        ctx({ intent: 'log_mileage', existingEntities: { mileageMiles: 0.005 } }),
      );
      expect(missingFieldsFor(res.proposal)).toContain('amountCents');
      expect(res.proposal.payload.amountCents).toBeUndefined();
    });

    // Domain cap (mirrors Task 8/9's MAX_QUANTITY lesson, quality-review
    // corrected rationale): this is a SANITY bound on a spoken figure (no
    // single logged trip is 10,000+ miles), not an overflow guard — int4
    // overflow (expenses.amount_cents) would need ~30.7 MILLION miles at
    // this rate, so 10,000 is a domain judgment, not a boundary requirement.
    // logExpensePayloadSchema has NO upper bound on amountCents (a real
    // expense — e.g. a new work van — legitimately runs into the tens of
    // thousands), so this handler-level cap is the ONLY thing between a
    // garbled spoken figure and Postgres.
    it('passes at the domain cap boundary (MAX_MILEAGE_MILES)', async () => {
      const res = await new LogExpenseTaskHandler().handle(
        ctx({ intent: 'log_mileage', existingEntities: { mileageMiles: MAX_MILEAGE_MILES } }),
      );
      expect(res.proposal.payload.amountCents).toBe(
        MAX_MILEAGE_MILES * DEFAULT_MILEAGE_RATE_CENTS_PER_MILE,
      );
      expect(missingFieldsFor(res.proposal)).toEqual([]);
    });

    it('gates on amountCents just over the domain cap boundary (MAX_MILEAGE_MILES + 1)', async () => {
      const res = await new LogExpenseTaskHandler().handle(
        ctx({ intent: 'log_mileage', existingEntities: { mileageMiles: MAX_MILEAGE_MILES + 1 } }),
      );
      expect(missingFieldsFor(res.proposal)).toContain('amountCents');
      expect(res.proposal.payload.amountCents).toBeUndefined();
    });

    it('falls back to the product-default timezone when the tenant zone is unresolved', async () => {
      const res = await new LogExpenseTaskHandler().handle(
        ctx({
          intent: 'log_mileage',
          now: new Date('2026-06-11T12:00:00.000Z'),
          existingEntities: { mileageMiles: 10 },
        }),
      );
      // America/New_York (DEFAULT_TENANT_TIMEZONE) noon UTC is still the same
      // calendar day — this only pins that a MISSING timezone never throws
      // and still produces a well-formed ISO instant, not a specific zone's
      // date.
      expect(res.proposal.payload.spentAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(missingFieldsFor(res.proposal)).toEqual([]);
    });

    it('a plain log_expense utterance (intent absent/log_expense, no mileageMiles) is completely unaffected', async () => {
      const res = await new LogExpenseTaskHandler().handle(
        ctx({ intent: 'log_expense', existingEntities: { amount: 5500, expenseCategory: 'fuel' } }),
      );
      expect(res.proposal.payload.category).toBe('fuel');
      expect(res.proposal.payload.amountCents).toBe(5500);
      expect(res.proposal.payload.description).not.toContain('Mileage');
    });

    // I1 (quality review, both legs) — the classifier's extractedEntities
    // shape is GLOBAL, not per-intent, so a real LLM turn can populate a
    // field that "belongs" to the other alias. Keying on `context.intent`
    // (rather than field presence) must make BOTH directions safe.
    describe('I1 — a stray field from the OTHER alias never hijacks or gets silently dropped', () => {
      it('log_expense intent with a stray mileageMiles present: real amount wins, never mileage math', async () => {
        const res = await new LogExpenseTaskHandler().handle(
          ctx({
            intent: 'log_expense',
            existingEntities: { amount: 24000, expenseCategory: 'materials', mileageMiles: 32 },
          }),
        );
        expect(res.proposal.payload.category).toBe('materials');
        expect(res.proposal.payload.amountCents).toBe(24000);
        expect(missingFieldsFor(res.proposal)).toEqual([]);
      });

      it('log_mileage intent with mileageMiles ABSENT never falls through to the plain amount branch (never a bogus "other" expense)', async () => {
        const res = await new LogExpenseTaskHandler().handle(
          ctx({ intent: 'log_mileage', existingEntities: { amount: 32 } }),
        );
        // Must stay in the mileage branch (category forced to 'vehicle') and
        // gate on amountCents — never silently accept the stray `amount` as
        // if it were a $0.32 "other" expense with zero missingFields.
        expect(res.proposal.payload.category).toBe('vehicle');
        expect(missingFieldsFor(res.proposal)).toContain('amountCents');
        expect(res.proposal.payload.amountCents).toBeUndefined();
      });

      it('log_mileage intent with BOTH mileageMiles and a stray amount: prefers the mileage math but preserves the spoken amount visibly', async () => {
        const res = await new LogExpenseTaskHandler().handle(
          ctx({ intent: 'log_mileage', existingEntities: { mileageMiles: 32, amount: 24000 } }),
        );
        expect(res.proposal.payload.amountCents).toBe(2240);
        expect(res.proposal.payload.category).toBe('vehicle');
        expect(res.proposal.payload.description).toContain('32 miles');
        expect(res.proposal.payload.description).toContain('$240.00');
        expect(missingFieldsFor(res.proposal)).toEqual([]);
      });

      it('log_mileage intent also carrying expenseDescription folds it into the visible description rather than discarding it', async () => {
        const res = await new LogExpenseTaskHandler().handle(
          ctx({
            intent: 'log_mileage',
            existingEntities: { mileageMiles: 18, expenseDescription: "today's supply run" },
          }),
        );
        expect(res.proposal.payload.description).toContain('18 miles');
        expect(res.proposal.payload.description).toContain("today's supply run");
      });
    });
  });
});

describe('ConvertLeadTaskHandler', () => {
  it('carries the lead reference and always flags leadId missing', async () => {
    const res = await new ConvertLeadTaskHandler().handle(
      ctx({ existingEntities: { leadReference: 'the Johnson lead' } }),
    );
    expect(res.proposal.proposalType).toBe('convert_lead');
    expect(res.proposal.payload.leadReference).toBe('the Johnson lead');
    expect(missingFieldsFor(res.proposal)).toContain('leadId');
  });
});

describe('wave-2 task handlers', () => {
  it('confirm_appointment resolves the single active appointment when a repo is wired', async () => {
    const repo = {
      listWithMeta: async () => ({ data: [{ id: 'appt-1', status: 'scheduled' }] }),
    } as unknown as import('../../../src/appointments/appointment').AppointmentRepository;
    const res = await new ConfirmAppointmentTaskHandler(repo).handle(ctx({}));
    expect(res.proposal.proposalType).toBe('confirm_appointment');
    expect(res.proposal.payload.appointmentId).toBe('appt-1');
    expect(missingFieldsFor(res.proposal)).not.toContain('appointmentId');
  });

  it('mark_lead_lost carries reason + reference and flags leadId missing', async () => {
    const res = await new MarkLeadLostTaskHandler().handle(
      ctx({ message: 'lost it', existingEntities: { leadReference: 'the Davis lead', lostReason: 'price' } }),
    );
    expect(res.proposal.proposalType).toBe('mark_lead_lost');
    expect(res.proposal.payload.leadReference).toBe('the Davis lead');
    expect(res.proposal.payload.reason).toBe('price');
    expect(missingFieldsFor(res.proposal)).toContain('leadId');
  });

  it('add_service_location requires structured address resolution', async () => {
    const res = await new AddServiceLocationTaskHandler().handle(
      ctx({ customerId: 'cust-1', existingEntities: { serviceAddress: '412 Oak St' } }),
    );
    expect(res.proposal.proposalType).toBe('add_service_location');
    expect(res.proposal.payload.addressText).toBe('412 Oak St');
    const missing = missingFieldsFor(res.proposal);
    expect(missing).toContain('street1');
    expect(missing).toContain('postalCode');
  });

  it('log_time_entry defaults entryType to job', async () => {
    const res = await new LogTimeEntryTaskHandler().handle(ctx({ existingEntities: {} }));
    expect(res.proposal.proposalType).toBe('log_time_entry');
    expect(res.proposal.payload.entryType).toBe('job');
  });

  // RV-051 — voice clock-in confirmation. The proposal IS the confirm
  // turn (capture-class, no trust tier → draft → human approves before
  // execution); these pin the readback + resolved-job content of it.
  it('log_time_entry carries the router-resolved jobId and a readback summary', async () => {
    const res = await new LogTimeEntryTaskHandler().handle(
      ctx({
        existingEntities: {
          jobReference: 'the Patel job',
          jobId: '33333333-3333-4333-8333-333333333333',
        },
      }),
    );
    expect(res.proposal.payload.jobId).toBe('33333333-3333-4333-8333-333333333333');
    expect(res.proposal.payload.jobReference).toBe('the Patel job');
    expect(res.proposal.summary).toBe('Clocking you in on the Patel job — right?');
    expect(missingFieldsFor(res.proposal)).not.toContain('jobId');
    // Confirm gate: never auto-approved — a human taps before the clock starts.
    expect(res.proposal.status).toBe('draft');
  });

  it('log_time_entry flags jobId missing when a job-type entry has no resolved job', async () => {
    const res = await new LogTimeEntryTaskHandler().handle(
      ctx({ existingEntities: { jobReference: 'the Patel job' } }),
    );
    expect(res.proposal.payload.jobId).toBeUndefined();
    expect(missingFieldsFor(res.proposal)).toContain('jobId');
    expect(res.proposal.status).toBe('draft');
    expect(res.proposal.summary).toBe('Clocking you in on the Patel job — right?');
  });

  it('log_time_entry break/drive entries need no job and read back their own confirmation', async () => {
    const breakRes = await new LogTimeEntryTaskHandler().handle(
      ctx({ existingEntities: { timeEntryType: 'break' } }),
    );
    expect(missingFieldsFor(breakRes.proposal)).toEqual([]);
    expect(breakRes.proposal.summary).toBe('Starting your break — right?');

    const driveRes = await new LogTimeEntryTaskHandler().handle(
      ctx({ existingEntities: { timeEntryType: 'drive' } }),
    );
    expect(driveRes.proposal.summary).toBe('Starting your drive time — right?');
  });

  it('notify_delay carries delay minutes and flags appointmentId when unresolved', async () => {
    const res = await new NotifyDelayTaskHandler().handle(
      ctx({ existingEntities: { appointmentReference: 'the 10am', delayMinutes: 30 } }),
    );
    expect(res.proposal.proposalType).toBe('notify_delay');
    expect(res.proposal.payload.delayMinutes).toBe(30);
    expect(missingFieldsFor(res.proposal)).toContain('appointmentId');
  });

  it('request_feedback carries the job reference but stays gated when the router never resolved a jobId (A32 fix)', async () => {
    const res = await new RequestFeedbackTaskHandler().handle(
      ctx({ existingEntities: { jobReference: 'the Johnson job' } }),
    );
    expect(res.proposal.proposalType).toBe('request_feedback');
    expect(res.proposal.payload.jobReference).toBe('the Johnson job');
    expect(res.proposal.payload.jobId).toBeUndefined();
    // BEFORE the A32 fix this proposal shipped with missingFields: [] —
    // approvable, then guaranteed to fail execution on
    // "request_feedback requires a resolved jobId" because payload.jobId was
    // never set. A free-text reference alone must never lift the gate.
    expect(missingFieldsFor(res.proposal)).toContain('jobId');
  });

  it('request_feedback resolves jobId from the router-verified existingEntities.jobId and lifts the gate', async () => {
    const jobId = '11111111-1111-4111-8111-111111111111';
    const res = await new RequestFeedbackTaskHandler().handle(
      ctx({ existingEntities: { jobId, jobReference: 'the Johnson job' } }),
    );
    expect(res.proposal.proposalType).toBe('request_feedback');
    expect(res.proposal.payload.jobId).toBe(jobId);
    // The spoken reference is still kept for the review card's display.
    expect(res.proposal.payload.jobReference).toBe('the Johnson job');
    expect(missingFieldsFor(res.proposal)).not.toContain('jobId');
  });

  it('request_feedback gates jobId when only a customer reference exists and no job was resolved', async () => {
    const res = await new RequestFeedbackTaskHandler().handle(
      ctx({ existingEntities: { customerName: 'Henderson' } }),
    );
    expect(res.proposal.proposalType).toBe('request_feedback');
    expect(res.proposal.payload.customerReference).toBe('Henderson');
    expect(res.proposal.payload.jobId).toBeUndefined();
    expect(missingFieldsFor(res.proposal)).toContain('jobId');
  });

  it('request_feedback gates jobId when nothing was spoken at all', async () => {
    const res = await new RequestFeedbackTaskHandler().handle(ctx({ existingEntities: {} }));
    expect(res.proposal.proposalType).toBe('request_feedback');
    expect(missingFieldsFor(res.proposal)).toContain('jobId');
  });
});

describe('RecordPaymentTaskHandler', () => {
  const INVOICE_ID = '22222222-2222-4222-8222-222222222222';

  it('resolves invoiceId from the router-verified existingEntities.invoiceId and lifts the gate (A22 fix)', async () => {
    const res = await new RecordPaymentTaskHandler().handle(
      ctx({
        existingEntities: {
          invoiceId: INVOICE_ID,
          customerName: 'Henderson',
          amount: 45000,
          paymentMethod: 'check',
          paymentReference: 'check 2044',
        },
      }),
    );
    expect(res.proposal.proposalType).toBe('record_payment');
    expect(res.proposal.payload.invoiceId).toBe(INVOICE_ID);
    // The spoken reference is still kept for the review card's display.
    expect(res.proposal.payload.invoiceReference).toBe('Henderson');
    expect(res.proposal.payload.amountCents).toBe(45000);
    expect(res.proposal.payload.paymentMethod).toBe('check');
    expect(missingFieldsFor(res.proposal)).not.toContain('invoiceId');
  });

  it('gates invoiceId when only a free-text reference exists and the router never resolved it', async () => {
    const res = await new RecordPaymentTaskHandler().handle(
      ctx({ existingEntities: { customerName: 'Henderson', amount: 45000 } }),
    );
    expect(res.proposal.proposalType).toBe('record_payment');
    expect(res.proposal.payload.invoiceReference).toBe('Henderson');
    expect(res.proposal.payload.invoiceId).toBeUndefined();
    // BEFORE the A22 fix this handler NEVER read existingEntities.invoiceId
    // at all, so even a resolver-verified id left invoiceId permanently
    // gated — see the DEVIATION note this fix removes in
    // test/proposals/voice-payload-contract.test.ts.
    expect(missingFieldsFor(res.proposal)).toContain('invoiceId');
  });

  it('accepts an already-resolved UUID reference directly, with no review-time resolution needed', async () => {
    const res = await new RecordPaymentTaskHandler().handle(
      ctx({ existingEntities: { jobReference: INVOICE_ID, amount: 45000 } }),
    );
    expect(res.proposal.payload.invoiceId).toBe(INVOICE_ID);
    expect(missingFieldsFor(res.proposal)).not.toContain('invoiceId');
  });
});

function approved(proposalType: ProposalType, payload: Record<string, unknown>): Proposal {
  const now = new Date();
  return {
    id: 'p-1',
    tenantId: 't-1',
    proposalType,
    status: 'approved',
    payload,
    summary: 'test',
    createdBy: 'u-1',
    createdAt: now,
    updatedAt: now,
  };
}

describe('NotifyDelayExecutionHandler', () => {
  it('resolves appointment→job→customer and sends a delay notice', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const delayService = {
      sendDelayNotice: async (req: Record<string, unknown>) => {
        sent.push(req);
        return { providerMessageId: 'msg-1' };
      },
    };
    const appointmentRepo = {
      findById: async () => ({ id: 'appt-1', jobId: 'job-1' }),
    } as unknown as import('../../../src/appointments/appointment').AppointmentRepository;
    const jobRepo = {
      findById: async () => ({ id: 'job-1', customerId: 'cust-1' }),
    } as unknown as import('../../../src/jobs/job').JobRepository;
    const customerRepo = {
      findById: async () => ({
        id: 'cust-1',
        displayName: 'Jane Smith',
        preferredChannel: 'sms',
        smsConsent: true,
        primaryPhone: '+15555550143',
      }),
    } as unknown as import('../../../src/customers/customer').CustomerRepository;

    const handler = new NotifyDelayExecutionHandler(
      delayService as unknown as import('../../../src/notifications/delay-notifications').DelayNotificationService,
      appointmentRepo,
      jobRepo,
      customerRepo,
    );
    const res = await handler.execute(approved('notify_delay', { appointmentId: 'appt-1', delayMinutes: 30 }), {
      tenantId: 't-1',
      executedBy: 'u-1',
    });
    expect(res.success).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].channel).toBe('sms');
    expect(sent[0].destination).toBe('+15555550143');
    expect(typeof sent[0].message).toBe('string');
    expect((sent[0].message as string).length).toBeGreaterThan(0);
  });

  it('degrades to passthrough success when deps are absent', async () => {
    const res = await new NotifyDelayExecutionHandler().execute(
      approved('notify_delay', { appointmentId: 'appt-1' }),
      { tenantId: 't-1', executedBy: 'u-1' },
    );
    expect(res.success).toBe(true);
  });
});

describe('ConvertLeadExecutionHandler', () => {
  it('rejects when leadId is unresolved', async () => {
    const handler = new ConvertLeadExecutionHandler();
    const res = await handler.execute(approved('convert_lead', { leadReference: 'x' }), {
      tenantId: 't-1',
      executedBy: 'u-1',
    });
    expect(res.success).toBe(false);
  });

  it('converts a real lead into a customer via the shared service', async () => {
    const leadRepo = new InMemoryLeadRepository();
    const customerRepo = new InMemoryCustomerRepository();
    const locationRepo = new InMemoryLocationRepository();
    const lead = await createLead(
      {
        tenantId: 't-1',
        firstName: 'Jane',
        lastName: 'Smith',
        primaryPhone: '+15555550100',
        source: 'phone_call',
        createdBy: 'u-1',
        street1: '100 Main St',
        city: 'Austin',
        state: 'TX',
        postalCode: '78701',
      },
      leadRepo,
    );

    const handler = new ConvertLeadExecutionHandler(
      leadRepo,
      customerRepo,
      undefined,
      locationRepo,
    );
    const res = await handler.execute(approved('convert_lead', { leadId: lead.id }), {
      tenantId: 't-1',
      executedBy: 'u-1',
    });

    expect(res.success).toBe(true);
    expect(res.resultEntityId).toBeDefined();
    const refreshed = await leadRepo.findById('t-1', lead.id);
    expect(refreshed?.convertedCustomerId).toBe(res.resultEntityId);
    const locations = await locationRepo.findByCustomer('t-1', res.resultEntityId!);
    expect(locations).toHaveLength(1);
    expect(locations[0].isPrimary).toBe(true);
  });
});

describe('caller-scoped appointment resolution (reschedule/cancel/confirm)', () => {
  const SOON = new Date(Date.now() + 24 * 60 * 60 * 1000); // upcoming

  // Two upcoming appointments belonging to two different customers. A
  // tenant-wide single-active scan would be ambiguous (2 active); the
  // caller-scoped resolver must pick only the caller's own appointment.
  function twoCustomerRepos(): { apptRepo: AppointmentRepository; jobRepo: JobRepository } {
    const apptRepo = {
      listWithMeta: async () => ({
        data: [
          { id: 'appt-A', jobId: 'job-A', status: 'scheduled', scheduledStart: SOON },
          { id: 'appt-B', jobId: 'job-B', status: 'scheduled', scheduledStart: SOON },
        ],
      }),
    } as unknown as AppointmentRepository;
    const jobRepo = {
      findById: async (_t: string, id: string) =>
        id === 'job-A'
          ? { id: 'job-A', customerId: 'cust-A' }
          : id === 'job-B'
            ? { id: 'job-B', customerId: 'cust-B' }
            : null,
    } as unknown as JobRepository;
    return { apptRepo, jobRepo };
  }

  it('reschedule resolves the CALLER\'s own appointment, never another customer\'s', async () => {
    const { apptRepo, jobRepo } = twoCustomerRepos();
    const res = await new RescheduleAppointmentTaskHandler(undefined, apptRepo, jobRepo).handle(
      ctx({ customerId: 'cust-A', existingEntities: { newDateTimeDescription: 'next Tue 2pm' } }),
    );
    expect(res.proposal.payload.appointmentId).toBe('appt-A');
    expect(missingFieldsFor(res.proposal)).not.toContain('appointmentId');
  });

  it('cancel resolves the caller\'s own appointment', async () => {
    const { apptRepo, jobRepo } = twoCustomerRepos();
    const res = await new CancelAppointmentTaskHandler(apptRepo, jobRepo).handle(
      ctx({ customerId: 'cust-B' }),
    );
    expect(res.proposal.payload.appointmentId).toBe('appt-B');
  });

  it('resolves the caller\'s own PAST appointment even when another customer has an upcoming one (scoping before upcoming)', async () => {
    const PAST = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const apptRepo = {
      listWithMeta: async () => ({
        data: [
          { id: 'appt-A-past', jobId: 'job-A', status: 'scheduled', scheduledStart: PAST },
          { id: 'appt-B-soon', jobId: 'job-B', status: 'scheduled', scheduledStart: SOON },
        ],
      }),
    } as unknown as AppointmentRepository;
    const jobRepo = {
      findById: async (_t: string, id: string) =>
        id === 'job-A' ? { id: 'job-A', customerId: 'cust-A' } : { id: 'job-B', customerId: 'cust-B' },
    } as unknown as JobRepository;
    const res = await new CancelAppointmentTaskHandler(apptRepo, jobRepo).handle(
      ctx({ customerId: 'cust-A' }),
    );
    expect(res.proposal.payload.appointmentId).toBe('appt-A-past');
  });

  it('UNSCOPED path (no caller identity) never auto-picks when >1 active exists, even if only one is upcoming', async () => {
    const PAST = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const apptRepo = {
      listWithMeta: async () => ({
        data: [
          { id: 'appt-past', jobId: 'job-X', status: 'scheduled', scheduledStart: PAST },
          { id: 'appt-soon', jobId: 'job-Y', status: 'scheduled', scheduledStart: SOON },
        ],
      }),
    } as unknown as AppointmentRepository;
    // No jobRepo, no customerId -> unscoped operator path. The legacy
    // "never auto-pick when >1 active" guard must hold (no upcoming narrowing).
    const res = await new ConfirmAppointmentTaskHandler(apptRepo).handle(ctx({}));
    expect(res.proposal.payload.appointmentId).toBeUndefined();
    expect(missingFieldsFor(res.proposal)).toContain('appointmentId');
  });

  it('notify_delay scopes to the caller so the delay SMS targets the right customer', async () => {
    const { apptRepo, jobRepo } = twoCustomerRepos();
    const res = await new NotifyDelayTaskHandler(apptRepo, jobRepo).handle(
      ctx({ customerId: 'cust-B', existingEntities: { delayMinutes: 20 } }),
    );
    expect(res.proposal.proposalType).toBe('notify_delay');
    expect(res.proposal.payload.appointmentId).toBe('appt-B');
  });

  it('leaves appointmentId missing when the caller has >1 upcoming appointment (ambiguous)', async () => {
    const apptRepo = {
      listWithMeta: async () => ({
        data: [
          { id: 'appt-A1', jobId: 'job-A', status: 'scheduled', scheduledStart: SOON },
          { id: 'appt-A2', jobId: 'job-A', status: 'scheduled', scheduledStart: SOON },
        ],
      }),
    } as unknown as AppointmentRepository;
    const jobRepo = {
      findById: async () => ({ id: 'job-A', customerId: 'cust-A' }),
    } as unknown as JobRepository;
    const res = await new ConfirmAppointmentTaskHandler(apptRepo, jobRepo).handle(
      ctx({ customerId: 'cust-A' }),
    );
    expect(res.proposal.payload.appointmentId).toBeUndefined();
    expect(missingFieldsFor(res.proposal)).toContain('appointmentId');
  });
});

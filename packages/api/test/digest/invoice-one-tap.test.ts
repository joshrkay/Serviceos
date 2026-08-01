/**
 * RV-065 — digest "invoice it" one-tap:
 *   - mintDraftInvoiceProposalForJob (eligibility via the batch-invoice
 *     query, payload parity with the batch fan-out, per-day dedupe)
 *   - renderDigestSms invoice links (lowest budget priority — dropped first)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mintDraftInvoiceProposalForJob } from '../../src/digest/invoice-one-tap';
import {
  renderDigestSmsSegments,
  type DailyDigestPayload,
  type DigestSmsApprovalLink,
  type DigestSmsInvoiceLink,
} from '../../src/digest/digest-service';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemoryJobRepository, Job } from '../../src/jobs/job';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { Estimate, InMemoryEstimateRepository } from '../../src/estimates/estimate';
import { buildLineItem, calculateDocumentTotals, LineItem } from '../../src/shared/billing-engine';

const TENANT = 't-1';
const JOB_ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: JOB_ID,
    tenantId: TENANT,
    customerId: CUSTOMER_ID,
    locationId: '33333333-3333-4333-8333-333333333333',
    jobNumber: 'JOB-1',
    summary: 'Heater replacement',
    status: 'completed',
    priority: 'normal',
    moneyState: 'estimate_accepted',
    createdBy: 'u-1',
    createdAt: new Date('2026-06-01T00:00:00Z'),
    updatedAt: new Date('2026-06-09T00:00:00Z'),
    ...overrides,
  } as Job;
}

function makeAcceptedEstimate(): Estimate {
  const lineItems: LineItem[] = [
    buildLineItem('44444444-4444-4444-8444-444444444444', 'Replace heater', 1, 120000, 0, true, 'labor'),
  ];
  return {
    id: '55555555-5555-4555-8555-555555555555',
    tenantId: TENANT,
    jobId: JOB_ID,
    estimateNumber: 'EST-1',
    status: 'accepted',
    lineItems,
    totals: calculateDocumentTotals(lineItems, 0, 250),
    acceptedAt: new Date('2026-06-08T00:00:00Z'),
    version: 1,
    createdBy: 'u-1',
    createdAt: new Date('2026-06-01T00:00:00Z'),
    updatedAt: new Date('2026-06-08T00:00:00Z'),
  };
}

describe('mintDraftInvoiceProposalForJob (RV-065)', () => {
  let proposalRepo: InMemoryProposalRepository;
  let jobRepo: InMemoryJobRepository;
  let invoiceRepo: InMemoryInvoiceRepository;
  let estimateRepo: InMemoryEstimateRepository;

  const deps = () => ({ proposalRepo, jobRepo, invoiceRepo, estimateRepo });

  beforeEach(async () => {
    proposalRepo = new InMemoryProposalRepository();
    jobRepo = new InMemoryJobRepository();
    invoiceRepo = new InMemoryInvoiceRepository();
    estimateRepo = new InMemoryEstimateRepository();
    await jobRepo.create(makeJob());
    await estimateRepo.create(makeAcceptedEstimate());
  });

  it('mints a draft_invoice proposal with the batch-parity payload', async () => {
    const result = await mintDraftInvoiceProposalForJob(TENANT, JOB_ID, 'one_tap_sms', deps());
    expect(result).toMatchObject({ ok: true });

    const proposals = await proposalRepo.findByTenant(TENANT);
    expect(proposals).toHaveLength(1);
    const draft = proposals[0];
    expect(draft.proposalType).toBe('draft_invoice');
    expect(draft.payload).toMatchObject({
      customerId: CUSTOMER_ID,
      jobId: JOB_ID,
      estimateId: '55555555-5555-4555-8555-555555555555',
      discountCents: 0,
      taxRateBps: 250, // accepted estimate's tax carried, batch parity
    });
    const li = (draft.payload.lineItems as Array<Record<string, unknown>>)[0];
    expect(li.unitPriceCents).toBe(120000);
    expect(li.unitPrice).toBe(120000); // alias the contract/review UI reads
    expect(draft.targetEntityId).toBe(JOB_ID);
  });

  it('answers job_not_eligible for a cross-tenant job id', async () => {
    const result = await mintDraftInvoiceProposalForJob('other-tenant', JOB_ID, 'one_tap_sms', deps());
    expect(result).toEqual({ ok: false, reason: 'job_not_eligible' });
  });

  it('answers job_not_eligible when nothing is billable (no accepted estimate)', async () => {
    estimateRepo = new InMemoryEstimateRepository(); // wipe the estimate
    const result = await mintDraftInvoiceProposalForJob(TENANT, JOB_ID, 'one_tap_sms', deps());
    expect(result).toEqual({ ok: false, reason: 'job_not_eligible' });
  });

  it('dedupes per job per day via the idempotency key', async () => {
    const first = await mintDraftInvoiceProposalForJob(TENANT, JOB_ID, 'one_tap_sms', deps());
    expect(first.ok).toBe(true);
    const second = await mintDraftInvoiceProposalForJob(TENANT, JOB_ID, 'one_tap_sms', deps());
    expect(second).toEqual({ ok: false, reason: 'already_minted' });
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// renderDigestSms — invoice links + budget priority
// ─────────────────────────────────────────────────────────────────────────────

function makePayload(overrides: Partial<DailyDigestPayload> = {}): DailyDigestPayload {
  return {
    date: '2026-06-10',
    timezone: 'America/Chicago',
    revenueCents: 48000,
    grossRevenueCents: 48000,
    refundsCents: 0,
    paymentsCount: 1,
    jobsCompletedCount: 2,
    tomorrow: { appointmentCount: 3, firstStartIso: null },
    pendingApprovals: { totalCount: 0, top: [] },
    overdueInvoicesCount: 0,
    unbilledJobs: [
      { jobId: JOB_ID, customerId: CUSTOMER_ID, customerName: 'Smith', amountCents: 48000 },
    ],
    ...overrides,
  };
}

const DEEP_LINK = 'https://app.example/digest/2026-06-10';

function approvalLink(n: number): DigestSmsApprovalLink {
  return {
    approval: { proposalId: `prop-${n}`, proposalType: 'draft_invoice', summary: `Approval ${n}` },
    url: `https://api.example/p/approve?token=APPROVE_TOKEN_${n}_xxxxxxxxxxxxxxxxxxxxxxxx`,
  };
}

function invoiceLink(n: number, name?: string): DigestSmsInvoiceLink {
  return {
    job: { jobId: `job-${n}`, customerId: 'c-1', ...(name ? { customerName: name } : {}), amountCents: 48000 },
    url: `https://api.example/p/approve?token=INVOICE_TOKEN_${n}_xxxxxxxxxxxxxxxxxxxxxxxx`,
  };
}

describe('renderDigestSmsSegments invoice links (RV-065)', () => {
  const combine = (segs: string[]) => segs.join('\n');

  it('appends a Bill entry per unbilled job with the one-tap URL and expiry note', () => {
    const segments = renderDigestSmsSegments({
      payload: makePayload(),
      deepLinkUrl: DEEP_LINK,
      approvalLinks: [],
      invoiceLinks: [invoiceLink(1, 'Smith')],
    });
    const body = combine(segments);
    expect(body).toContain('Bill Smith $480 https://api.example/p/approve?token=INVOICE_TOKEN_1');
    expect(body).toContain('(links expire in 30 min)');
    expect(body).toContain(DEEP_LINK);
    for (const s of segments) expect(s.length).toBeLessThanOrEqual(480);
  });

  it('never lets punctuation directly follow an invoice URL', () => {
    // Keep it a single segment so the token isn't followed by a segment join.
    const segments = renderDigestSmsSegments({
      payload: makePayload(),
      deepLinkUrl: DEEP_LINK,
      approvalLinks: [],
      invoiceLinks: [invoiceLink(1)],
    });
    for (const body of segments) {
      const idx = body.indexOf('INVOICE_TOKEN_1_xxxxxxxxxxxxxxxxxxxxxxxx');
      if (idx === -1) continue;
      const after = body[idx + 'INVOICE_TOKEN_1_xxxxxxxxxxxxxxxxxxxxxxxx'.length];
      expect(after === ' ' || after === undefined).toBe(true);
    }
  });

  it('preserves ALL approval and invoice links across segments (never collapsed/dropped)', () => {
    const payload = makePayload({ pendingApprovals: { totalCount: 2, top: [] } });
    const approvals = [approvalLink(1), approvalLink(2)];
    const invoices = [invoiceLink(1, 'Smith'), invoiceLink(2, 'Jones')];

    const segments = renderDigestSmsSegments({
      payload,
      deepLinkUrl: DEEP_LINK,
      approvalLinks: approvals,
      invoiceLinks: invoices,
    });
    const body = combine(segments);
    // Links spill into later segments rather than being sacrificed.
    expect(body).toContain('APPROVE_TOKEN_1');
    expect(body).toContain('APPROVE_TOKEN_2');
    expect(body).toContain('INVOICE_TOKEN_1');
    expect(body).toContain('INVOICE_TOKEN_2');
    expect(body).not.toMatch(/\+\d more/);
    for (const s of segments) expect(s.length).toBeLessThanOrEqual(480);
  });

  it('omitting invoiceLinks renders identically to passing an empty array', () => {
    const payload = makePayload({ pendingApprovals: { totalCount: 1, top: [] } });
    const a = renderDigestSmsSegments({
      payload,
      deepLinkUrl: DEEP_LINK,
      approvalLinks: [approvalLink(1)],
    });
    const b = renderDigestSmsSegments({
      payload,
      deepLinkUrl: DEEP_LINK,
      approvalLinks: [approvalLink(1)],
      invoiceLinks: [],
    });
    expect(a).toEqual(b);
    expect(combine(a)).toContain('Approvals: 1 waiting');
  });
});

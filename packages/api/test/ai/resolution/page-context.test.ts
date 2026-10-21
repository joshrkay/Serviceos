import { describe, it, expect } from 'vitest';
import {
  isDeicticReference,
  loadPageContext,
  mergePageContextIds,
  pageContextNote,
  pageContextSchema,
  pageLookupIds,
  pageUnavailableReply,
  pointsAtPageRecord,
  pageNoteTargetKind,
  type PageContextRepos,
} from '../../../src/ai/resolution/page-context';

const TENANT = '11111111-1111-4111-8111-111111111111';
const JOB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CUSTOMER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const INVOICE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const jobPage = { ids: { jobId: JOB, customerId: CUSTOMER } };

function merge(over: Partial<Parameters<typeof mergePageContextIds>[0]>) {
  return mergePageContextIds({
    intent: 'add_note',
    entities: {},
    text: 'add a note: gate code 4471',
    resolvedIds: {},
    ambiguousRefKeys: [],
    page: jobPage,
    ...over,
  });
}

describe('mergePageContextIds', () => {
  it('fills every id when the operator named no record', () => {
    const out = merge({});
    expect(out.ids).toEqual({ jobId: JOB, customerId: CUSTOMER });
    expect(out.filledKeys.sort()).toEqual(['customerId', 'jobId']);
  });

  it('fills when the operator only pointed at the record', () => {
    const out = merge({
      intent: 'update_job',
      entities: { jobReference: 'this job', customerName: 'them' },
      text: 'mark this job high priority',
      ambiguousRefKeys: ['jobId'],
    });
    expect(out.ids.jobId).toBe(JOB);
    expect(out.ambiguousRefKeys).toEqual([]);
  });

  it('fills the gaps when the named record is the one on screen', () => {
    const out = merge({
      intent: 'create_invoice',
      entities: { customerName: 'Garcia', jobReference: 'this job' },
      text: 'invoice the Garcias for this job',
      resolvedIds: { customerId: CUSTOMER },
    });
    expect(out.ids).toEqual({ customerId: CUSTOMER, jobId: JOB });
    expect(out.filledKeys).toEqual(['jobId']);
  });

  it('is ignored when the resolver found a different record', () => {
    const out = merge({
      intent: 'update_customer',
      entities: { customerName: 'Priya Shah' },
      text: "update Priya Shah's phone",
      resolvedIds: { customerId: OTHER },
    });
    expect(out).toEqual({ ids: { customerId: OTHER }, ambiguousRefKeys: [], filledKeys: [] });
  });

  it('never swaps an unresolved name for the record on screen', () => {
    const out = merge({
      intent: 'update_customer',
      entities: { customerName: 'Smith' },
      text: "update Smith's phone",
      ambiguousRefKeys: ['customerId'],
    });
    expect(out.filledKeys).toEqual([]);
    expect(out.ambiguousRefKeys).toEqual(['customerId']);
  });

  it('keeps a differently named job unfilled even when the customer matches', () => {
    const out = merge({
      intent: 'create_invoice',
      entities: { customerName: 'Garcia', jobReference: 'the water heater job' },
      text: 'invoice the Garcia water heater job',
      resolvedIds: { customerId: CUSTOMER },
      ambiguousRefKeys: ['jobId'],
    });
    expect(out.ids.jobId).toBeUndefined();
    expect(out.ambiguousRefKeys).toEqual(['jobId']);
  });

  it('is ignored when the words carry a document number or a literal id', () => {
    expect(merge({ text: 'send invoice INV-0042' }).filledKeys).toEqual([]);
    expect(merge({ text: `send invoice ${OTHER}` }).filledKeys).toEqual([]);
  });

  it('never gives a new record the id of the one on screen', () => {
    expect(merge({ intent: 'create_customer', entities: { name: 'Maria Alvarez' } }).filledKeys).toEqual([]);
    expect(merge({ intent: 'create_job' }).filledKeys).toEqual(['customerId']);
  });
});

describe('isDeicticReference', () => {
  it.each(['this job', 'That invoice.', 'them', 'her', 'the customer', 'this one'])('%s points', (ref) => {
    expect(isDeicticReference(ref)).toBe(true);
  });
  it.each(['Garcia', 'the Garcia job', 'this Garcia job', 'INV-0042'])('%s names', (ref) => {
    expect(isDeicticReference(ref)).toBe(false);
  });
});

describe('loadPageContext', () => {
  const repos: PageContextRepos = {
    customerRepo: {
      findById: async (tenantId, id) =>
        tenantId === TENANT && id === CUSTOMER ? ({ id, displayName: 'Ana Garcia' } as never) : null,
    },
    jobRepo: {
      findById: async (tenantId, id) =>
        tenantId === TENANT && id === JOB
          ? ({ id, customerId: CUSTOMER, summary: 'AC not cooling', jobNumber: 'JOB-0081' } as never)
          : null,
    },
    invoiceRepo: {
      findById: async (tenantId, id) =>
        tenantId === TENANT && id === INVOICE ? ({ id, jobId: JOB, invoiceNumber: 'INV-0042' } as never) : null,
    },
  };

  it('expands a job page to its job and customer', async () => {
    const page = await loadPageContext(repos, TENANT, { entityType: 'job', entityId: JOB });
    expect(page?.ids).toEqual({ jobId: JOB, customerId: CUSTOMER });
    expect(page && pageContextNote(page)).toBe('I used the job you had open: Ana Garcia – AC not cooling.');
  });

  it('expands an invoice page to the invoice, its job and its customer', async () => {
    const page = await loadPageContext(repos, TENANT, { entityType: 'invoice', entityId: INVOICE });
    expect(page?.ids).toEqual({ invoiceId: INVOICE, jobId: JOB, customerId: CUSTOMER });
    expect(page?.label).toBe('INV-0042 (Ana Garcia – AC not cooling)');
    expect(page?.documentNumber).toBe('INV-0042');
  });

  it("returns nothing for another tenant's record", async () => {
    const other = '99999999-9999-4999-8999-999999999999';
    expect(await loadPageContext(repos, other, { entityType: 'job', entityId: JOB })).toBeUndefined();
  });

  it('returns nothing when the repo is missing or throws', async () => {
    expect(await loadPageContext({}, TENANT, { entityType: 'estimate', entityId: JOB })).toBeUndefined();
    const throwing: PageContextRepos = {
      customerRepo: { findById: async () => { throw new Error('db down'); } },
    };
    expect(await loadPageContext(throwing, TENANT, { entityType: 'customer', entityId: CUSTOMER })).toBeUndefined();
  });

  it('rejects an unknown page type or an empty id at the schema', () => {
    expect(pageContextSchema.safeParse({ entityType: 'lead', entityId: JOB }).success).toBe(false);
    expect(pageContextSchema.safeParse({ entityType: 'job', entityId: '' }).success).toBe(false);
  });

  it('keeps a bad id past the schema so the route can say it could not open it', async () => {
    expect(pageContextSchema.safeParse({ entityType: 'job', entityId: 'nope' }).success).toBe(true);
    expect(await loadPageContext(repos, TENANT, { entityType: 'job', entityId: 'nope' })).toBeUndefined();
  });
});

describe('pointsAtPageRecord', () => {
  it('matches words pointing at the record on screen, or its customer', () => {
    expect(pointsAtPageRecord('job', 'which estimates are on this job?')).toBe(true);
    expect(pointsAtPageRecord('job', 'change her phone')).toBe(true);
    expect(pointsAtPageRecord('invoice', 'is this invoice paid?')).toBe(true);
    expect(pointsAtPageRecord('customer', 'what does she owe?')).toBe(true);
    // An invoice page names its job, so "this job" points at it too.
    expect(pointsAtPageRecord('invoice', 'which estimates are on this job?')).toBe(true);
  });

  it('ignores a question that does not point at the page', () => {
    expect(pointsAtPageRecord('job', "what's on today's schedule?")).toBe(false);
    expect(pointsAtPageRecord('invoice', 'which estimates are still open?')).toBe(false);
    expect(pointsAtPageRecord('customer', 'which estimates are on this job?')).toBe(false);
  });
});

describe('pageUnavailableReply', () => {
  it('says it could not open the record and asks which one', () => {
    expect(pageUnavailableReply('job')).toBe(
      "I couldn't open the job you were viewing, so I can't tell which job you mean. Which one is it?",
    );
  });
});

describe('pageLookupIds', () => {
  const lookup = (over: Partial<Parameters<typeof pageLookupIds>[0]>) =>
    pageLookupIds({
      intent: 'lookup_invoices',
      entities: {},
      text: 'what invoices are open?',
      page: { ...jobPage, context: { entityType: 'job' } },
      ...over,
    });

  it('fills the customer when the question points at them', () => {
    expect(lookup({ entities: { customerName: 'this customer' }, text: 'what invoices does this customer have?' })).toEqual({
      customerId: CUSTOMER,
    });
    expect(lookup({ intent: 'lookup_balance', text: 'what does she owe?' })).toEqual({ customerId: CUSTOMER });
  });

  it('leaves a question with a tenant-wide reading alone', () => {
    expect(lookup({})).toEqual({});
  });

  it('never replaces a named customer, a document number or a literal id', () => {
    expect(lookup({ entities: { customerName: 'Maria Alvarez' }, text: 'what invoices does Maria Alvarez have?' })).toEqual({});
    expect(lookup({ text: 'what is the status of INV-0042 for her?' })).toEqual({});
    expect(lookup({ text: `invoices for ${OTHER} and her` })).toEqual({});
  });

  it('keeps a named customer even when the question also says "this job"', () => {
    expect(
      lookup({
        entities: { customerName: 'Maria Alvarez', jobReference: 'this job' },
        text: 'what invoices does Maria Alvarez have on this job?',
      }),
    ).toEqual({ jobId: JOB });
  });

  it('fills the customer only for customer-scoped lookups', () => {
    expect(lookup({ intent: 'lookup_my_day', text: "what's on my day, is she first?" })).toEqual({});
  });

  it('fills the job when the question points at this job', () => {
    expect(lookup({ intent: 'lookup_jobs', entities: { jobReference: 'this job' }, text: "what's the status of this job?" })).toEqual({
      customerId: CUSTOMER,
      jobId: JOB,
    });
    expect(lookup({ intent: 'lookup_my_day', text: 'is this job first today?' })).toEqual({ jobId: JOB });
    expect(lookup({ intent: 'lookup_jobs', entities: { jobReference: 'the Patel job' }, text: 'status of the Patel job?' })).toEqual({});
  });
});

describe('pageLookupIds on a document page', () => {
  const invoicePage = {
    ids: { invoiceId: INVOICE, jobId: JOB, customerId: CUSTOMER },
    documentNumber: 'INV-0042',
    context: { entityType: 'invoice' as const },
  };

  it('"is this invoice paid?" on INV-0042 answers by that number, its job and its customer', () => {
    expect(pageLookupIds({ intent: 'lookup_invoices', entities: {}, text: 'is this invoice paid?', page: invoicePage })).toEqual({
      customerId: CUSTOMER,
      jobId: JOB,
      documentNumber: 'INV-0042',
    });
  });

  it('"when is this appointment?" on an appointment page reads that customer\'s appointments', () => {
    const appointmentPage = { ids: { appointmentId: OTHER, jobId: JOB, customerId: CUSTOMER }, context: { entityType: 'appointment' as const } };
    expect(
      pageLookupIds({ intent: 'lookup_appointments', entities: {}, text: 'when is this appointment?', page: appointmentPage }),
    ).toEqual({ customerId: CUSTOMER, jobId: JOB });
  });

  it('a question about another kind of record does not read the page by its number', () => {
    const jobDocPage = { ids: { jobId: JOB, customerId: CUSTOMER }, documentNumber: 'JOB-0081', context: { entityType: 'job' as const } };
    expect(
      pageLookupIds({ intent: 'lookup_invoices', entities: {}, text: 'what invoices are on this job?', page: jobDocPage }),
    ).toEqual({ customerId: CUSTOMER, jobId: JOB });
    expect(
      pageLookupIds({ intent: 'lookup_jobs', entities: {}, text: "what's the status of this job?", page: jobDocPage }),
    ).toEqual({ customerId: CUSTOMER, jobId: JOB, documentNumber: 'JOB-0081' });
  });

  it('a question that does not point at the invoice leaves it alone', () => {
    expect(pageLookupIds({ intent: 'lookup_invoices', entities: {}, text: 'what invoices are open?', page: invoicePage })).toEqual({});
  });
});

describe('pageNoteTargetKind', () => {
  const target = (over: Partial<Parameters<typeof pageNoteTargetKind>[0]>) =>
    pageNoteTargetKind({
      intent: 'add_note',
      entities: { noteBody: 'customer disputed this charge' },
      text: 'add a note: customer disputed this charge',
      page: { context: { entityType: 'invoice' } },
      filledKeys: ['invoiceId', 'jobId', 'customerId'],
      ...over,
    });

  it('targets the document or customer on screen', () => {
    expect(target({})).toBe('invoice');
    expect(target({ page: { context: { entityType: 'estimate' } }, filledKeys: ['estimateId', 'jobId'] })).toBe('estimate');
    expect(target({ page: { context: { entityType: 'customer' } }, filledKeys: ['customerId'], text: 'note: she prefers mornings' })).toBe('customer');
  });

  it('leaves the job default alone where the page or the words say so', () => {
    expect(target({ page: { context: { entityType: 'job' } }, filledKeys: ['jobId', 'customerId'] })).toBeUndefined();
    expect(target({ text: 'add a note to this job: gate code' })).toBeUndefined();
    expect(target({ text: 'add a note for her: call after 5' })).toBeUndefined();
    expect(target({ entities: { noteTargetKind: 'customer' } })).toBeUndefined();
    expect(target({ filledKeys: ['jobId'] })).toBeUndefined();
    expect(target({ intent: 'update_job' })).toBeUndefined();
  });
});

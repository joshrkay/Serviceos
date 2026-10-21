import { describe, it, expect } from 'vitest';
import {
  isDeicticReference,
  loadPageContext,
  mergePageContextIds,
  pageContextNote,
  pageContextSchema,
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

  it('rejects a malformed context at the schema', () => {
    expect(pageContextSchema.safeParse({ entityType: 'lead', entityId: JOB }).success).toBe(false);
    expect(pageContextSchema.safeParse({ entityType: 'job', entityId: 'nope' }).success).toBe(false);
  });
});

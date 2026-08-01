import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  InMemoryFinancingRepository,
  applyFinancingStatusUpdate,
  offerFinancing,
  validateOfferFinancing,
  FINANCING_MIN_CENTS,
} from '../../src/financing/financing';
import {
  ManualFinancingProvider,
  WisetackFinancingProvider,
  createFinancingProvider,
  mapWisetackStatus,
  type FinancingProviderClient,
} from '../../src/financing/financing-provider';
import { InMemoryAuditRepository } from '../../src/audit/audit';

const TENANT = '11111111-1111-1111-1111-111111111111';
const INVOICE = '22222222-2222-2222-2222-222222222222';
const ACTOR = 'user-1';

function baseInput(over: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    invoiceId: INVOICE,
    customerId: null,
    amountCents: 120_00,
    invoiceNumber: 'INV-1',
    customerName: 'Pat Property',
    createdBy: ACTOR,
    ...over,
  };
}

describe('financing (FIN) — validation', () => {
  it('requires a positive amount above the floor', () => {
    expect(validateOfferFinancing({ amountCents: 0 })).toContain(
      'amountCents must be a positive integer (cents)',
    );
    expect(validateOfferFinancing({ amountCents: FINANCING_MIN_CENTS - 1 })[0]).toMatch(
      /at least/,
    );
    expect(validateOfferFinancing({ amountCents: FINANCING_MIN_CENTS })).toHaveLength(0);
  });
});

describe('financing (FIN) — offer + status orchestration', () => {
  let repo: InMemoryFinancingRepository;
  let audit: InMemoryAuditRepository;

  beforeEach(() => {
    repo = new InMemoryFinancingRepository();
    audit = new InMemoryAuditRepository();
  });

  it('offers financing via the provider and persists the application + audit', async () => {
    const provider: FinancingProviderClient = {
      name: 'wisetack',
      createApplication: vi.fn().mockResolvedValue({
        externalId: 'wt_1',
        applicationUrl: 'https://apply.example/wt_1',
        status: 'offered',
      }),
    };
    const app = await offerFinancing(baseInput(), repo, provider, audit);
    expect(app.provider).toBe('wisetack');
    expect(app.externalId).toBe('wt_1');
    expect(app.applicationUrl).toBe('https://apply.example/wt_1');
    expect(app.status).toBe('offered');
    // Our application id is echoed to the provider for webhook resolution.
    expect(vi.mocked(provider.createApplication)).toHaveBeenCalledWith(
      expect.objectContaining({ applicationId: app.id, tenantId: TENANT }),
      app.id,
    );
    const events = await audit.findByEntity(TENANT, 'invoice', INVOICE);
    expect(events[0].eventType).toBe('financing.offered');
  });

  it('rejects an amount below the floor before calling the provider', async () => {
    const provider = new ManualFinancingProvider();
    const spy = vi.spyOn(provider, 'createApplication');
    await expect(
      offerFinancing(baseInput({ amountCents: 100 }), repo, provider),
    ).rejects.toThrow(/at least/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('applies a status update and emits an audit event', async () => {
    const app = await offerFinancing(baseInput(), repo, new ManualFinancingProvider(), audit);
    const updated = await applyFinancingStatusUpdate(TENANT, app.id, 'approved', null, repo, audit);
    expect(updated?.status).toBe('approved');
    const events = await audit.findByEntity(TENANT, 'invoice', INVOICE);
    expect(events.some((e) => e.eventType === 'financing.status_changed')).toBe(true);
  });

  it('does not transition out of a terminal state', async () => {
    const app = await offerFinancing(baseInput(), repo, new ManualFinancingProvider());
    await applyFinancingStatusUpdate(TENANT, app.id, 'declined', 'low score', repo);
    const after = await applyFinancingStatusUpdate(TENANT, app.id, 'approved', null, repo);
    expect(after?.status).toBe('declined'); // terminal, unchanged
  });

  it('ignores a stale lower-ranked update once the application has advanced', async () => {
    const app = await offerFinancing(baseInput(), repo, new ManualFinancingProvider());
    await applyFinancingStatusUpdate(TENANT, app.id, 'approved', null, repo);
    // Retried/out-of-order older webhooks (or unknown statuses mapped to
    // 'offered') must not move an approved application backwards.
    expect((await applyFinancingStatusUpdate(TENANT, app.id, 'prequalified', null, repo))?.status).toBe(
      'approved',
    );
    expect((await applyFinancingStatusUpdate(TENANT, app.id, 'offered', null, repo))?.status).toBe(
      'approved',
    );
    // A terminal transition still lands.
    expect((await applyFinancingStatusUpdate(TENANT, app.id, 'funded', null, repo))?.status).toBe('funded');
  });

  it('is tenant-isolated', async () => {
    const app = await offerFinancing(baseInput(), repo, new ManualFinancingProvider());
    expect(await repo.findById('99999999-9999-9999-9999-999999999999', app.id)).toBeNull();
    expect(
      await applyFinancingStatusUpdate('99999999-9999-9999-9999-999999999999', app.id, 'approved', null, repo),
    ).toBeNull();
  });
});

describe('financing (FIN) — Wisetack provider', () => {
  it('maps provider statuses to our taxonomy', () => {
    expect(mapWisetackStatus('AUTHORIZED')).toBe('approved');
    expect(mapWisetackStatus('settled')).toBe('funded');
    expect(mapWisetackStatus('declined')).toBe('declined');
    expect(mapWisetackStatus('expired')).toBe('expired');
    expect(mapWisetackStatus('something_new')).toBe('offered');
  });

  it('posts the application and parses the response (cents → dollars, echoed ref)', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ transaction_id: 'wt_9', consumer_url: 'https://apply/wt_9', status: 'initiated' }),
    } as unknown as Response);
    const provider = new WisetackFinancingProvider({
      apiKey: 'k',
      apiBase: 'https://api-sandbox.wisetack.com/',
      fetchFn,
    });
    const result = await provider.createApplication(
      {
        applicationId: 'app-1',
        tenantId: TENANT,
        amountCents: 150_00,
        invoiceNumber: 'INV-9',
        customerName: 'Pat',
        customerEmail: 'pat@example.com',
      },
      'idem-1',
    );
    expect(result).toEqual({
      externalId: 'wt_9',
      applicationUrl: 'https://apply/wt_9',
      status: 'offered',
    });
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://api-sandbox.wisetack.com/v1/transactions');
    expect(init.headers['Idempotency-Key']).toBe('idem-1');
    const sent = JSON.parse(init.body);
    expect(sent.transaction_amount).toBe(150); // 150_00 cents → $150
    expect(sent.external_reference).toBe(`${TENANT}:app-1`);
  });

  it('throws on a non-OK provider response', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => 'bad request',
    } as unknown as Response);
    const provider = new WisetackFinancingProvider({ apiKey: 'k', apiBase: 'https://x', fetchFn });
    await expect(
      provider.createApplication({
        applicationId: 'a',
        tenantId: TENANT,
        amountCents: 100_00,
        invoiceNumber: 'INV',
        customerName: 'P',
      }),
    ).rejects.toThrow(/Wisetack createApplication failed \(422\)/);
  });

  it('factory picks Manual when no API key is configured', () => {
    expect(createFinancingProvider({ apiKey: undefined }).name).toBe('manual');
    expect(createFinancingProvider({ apiKey: 'k', apiBase: 'https://x' }).name).toBe('wisetack');
  });
});

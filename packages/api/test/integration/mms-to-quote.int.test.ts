/**
 * U2 — MMS-to-quote integration (Docker-gated; NOT run in web sessions).
 *
 * Requires the testcontainer Postgres started by `npm run test:integration`.
 * Pins the full customer-MMS intake against REAL Postgres + RLS: an inbound
 * customer MMS (from a non-tech number) resolves/creates the customer,
 * stores + presigns the photo, drafts a catalog-grounded `draft_estimate`,
 * and PERSISTS the proposal row with `tenant_id` plus an audit event. Unit
 * tests mock the repos; this proves the real columns/RLS path works (the
 * "mocked-pool shipped bad columns" failure mode).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, type TestTenant } from './shared';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgFileRepository } from '../../src/files/pg-file';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgCatalogItemRepository } from '../../src/catalog/pg-catalog-item';
import { DevStorageProvider } from '../../src/files/storage-provider';
import {
  createCatalogItem,
  persistCatalogItem,
} from '../../src/catalog/catalog-item';
import { createCustomer, type CustomerRepository } from '../../src/customers/customer';
import {
  ingestCustomerMms,
  type CustomerMmsIntakeDeps,
} from '../../src/sms/customer-mms/customer-mms-intake';
import type { InboundSmsContext } from '../../src/sms/inbound-dispatch';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';

const CUSTOMER_PHONE = '+15125550456';

function gatewayReturning(content: string): LLMGateway {
  return {
    complete: vi.fn(async () => ({
      content,
      model: 'mock',
      provider: 'mock',
      tokenUsage: { input: 1, output: 1, total: 2 },
      latencyMs: 1,
    } satisfies LLMResponse)),
  } as unknown as LLMGateway;
}

const visionJson = JSON.stringify({
  lineItems: [
    // Within PRICE_CONFLICT tolerance of the 15000¢ catalog price — a larger
    // deviation is a "did you mean" conflict, not a silent snap.
    { description: 'Drywall patch', quantity: 1, unitPrice: 15600, category: 'labor' },
    { description: 'Bespoke trim work', quantity: 1, unitPrice: 7500, category: 'material' },
  ],
  notes: 'Hole near the window.',
  confidence_score: 0.78,
});

function inbound(overrides: Partial<InboundSmsContext> = {}): InboundSmsContext {
  return {
    tenantId: '',
    fromE164: CUSTOMER_PHONE,
    body: 'Can you quote this?',
    messageSid: `SM-int-${crypto.randomUUID()}`,
    media: [{ url: 'https://api.twilio.com/media/INT1', contentType: 'image/jpeg' }],
    ...overrides,
  };
}

describe('Postgres integration — MMS-to-quote (U2)', () => {
  let pool: Pool;
  let tenant: TestTenant;
  let deps: CustomerMmsIntakeDeps;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    tenant = await createTestTenant(pool);

    const catalogRepo = new PgCatalogItemRepository(pool);
    const auditRepo = new PgAuditRepository(pool);
    // Seed one matching catalog item so price grounding is exercised.
    await persistCatalogItem(
      catalogRepo,
      createCatalogItem({
        tenantId: tenant.tenantId,
        name: 'Drywall patch',
        category: 'Labor',
        unit: 'each',
        unitPriceCents: 15000,
      }),
      { userId: tenant.userId, role: 'owner' },
      auditRepo,
    );

    deps = {
      customerRepo: new PgCustomerRepository(pool),
      proposalRepo: new PgProposalRepository(pool),
      fileRepo: new PgFileRepository(pool),
      storage: new DevStorageProvider({
        bucket: 'test-bucket',
        publicUrlBase: 'http://localhost:3000/storage-dev',
      }),
      storageBucket: 'test-bucket',
      fetchMedia: vi.fn(async () => ({ bytes: Buffer.from('jpeg-bytes'), contentType: 'image/jpeg' })),
      gateway: gatewayReturning(visionJson),
      catalogRepo,
      auditRepo,
      notifyOwner: vi.fn(async () => {}),
    };
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('unknown customer MMS → draft_estimate proposal persisted with tenant_id + audit', async () => {
    const ctx = inbound({ tenantId: tenant.tenantId });
    const result = await ingestCustomerMms(ctx, deps);

    expect(result.outcome).toBe('drafted');
    expect(result.proposalId).toBeDefined();
    expect(result.customerId).toBeDefined();

    // Proposal persisted under the tenant (RLS-scoped read).
    const proposalRepo = deps.proposalRepo as PgProposalRepository;
    const stored = await proposalRepo.findById(tenant.tenantId, result.proposalId!);
    expect(stored).not.toBeNull();
    expect(stored!.tenantId).toBe(tenant.tenantId);
    expect(stored!.proposalType).toBe('draft_estimate');
    expect(stored!.payload.customerId).toBe(result.customerId);
    // Never auto-issued — uncatalogued trim line caps confidence below
    // the auto-approve threshold, so it lands in the owner queue.
    expect(stored!.status).not.toBe('approved');
    expect(stored!.status).not.toBe('executed');

    // Catalog grounding applied: the matched line uses the catalog price.
    const lineItems = stored!.payload.lineItems as Array<Record<string, unknown>>;
    const patch = lineItems.find((li) => String(li.description).includes('Drywall'));
    expect(patch?.unitPrice).toBe(15000);
    expect(patch?.pricingSource).toBe('catalog');

    // New customer was created and round-trips from Postgres.
    const customerRepo = deps.customerRepo as PgCustomerRepository;
    const customer = await customerRepo.findById(tenant.tenantId, result.customerId!);
    expect(customer).not.toBeNull();
    expect(customer!.primaryPhone).toBe(CUSTOMER_PHONE);

    // Audit event for the draft is persisted against the proposal.
    const auditRepo = deps.auditRepo as PgAuditRepository;
    const events = await auditRepo.findByEntity(tenant.tenantId, 'proposal', result.proposalId!);
    expect(events.some((e) => e.eventType === 'customer_mms.estimate_drafted')).toBe(true);

    // File row for the stored photo carries the tenant + customer linkage.
    const fileRepo = deps.fileRepo as PgFileRepository;
    const files = await fileRepo.findByEntity(tenant.tenantId, 'customer', result.customerId!);
    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(files[0].tenantId).toBe(tenant.tenantId);

    // U3 — a successful draft surfaces to the owner (heads-up SMS via notifyOwner).
    expect(deps.notifyOwner).toHaveBeenCalledWith(
      tenant.tenantId,
      expect.stringContaining('photo quote'),
    );
  });

  it('known customer MMS → drafts against the resolved customer (no duplicate created)', async () => {
    const knownPhone = '+15125550789';
    const known = await createCustomer(
      {
        tenantId: tenant.tenantId,
        firstName: 'Jenna',
        lastName: 'PM',
        primaryPhone: knownPhone,
        createdBy: tenant.userId,
      },
      deps.customerRepo as CustomerRepository,
    );

    const ctx = inbound({ tenantId: tenant.tenantId, fromE164: knownPhone });
    const result = await ingestCustomerMms(ctx, deps);

    expect(result.outcome).toBe('drafted');
    expect(result.customerId).toBe(known.id);
    const stored = await (deps.proposalRepo as PgProposalRepository).findById(
      tenant.tenantId,
      result.proposalId!,
    );
    expect(stored!.payload.customerId).toBe(known.id);
  });

  it('ambiguous sender (shared phone) → clarification proposal, no draft_estimate', async () => {
    const sharedPhone = '+15125550321';
    for (const name of ['Alice', 'Bob']) {
      await createCustomer(
        {
          tenantId: tenant.tenantId,
          firstName: name,
          lastName: 'Household',
          primaryPhone: sharedPhone,
          createdBy: tenant.userId,
        },
        deps.customerRepo as CustomerRepository,
      );
    }

    const ctx = inbound({ tenantId: tenant.tenantId, fromE164: sharedPhone });
    const result = await ingestCustomerMms(ctx, deps);

    expect(result.outcome).toBe('clarification');
    const stored = await (deps.proposalRepo as PgProposalRepository).findById(
      tenant.tenantId,
      result.proposalId!,
    );
    expect(stored!.proposalType).toBe('voice_clarification');
    expect(stored!.tenantId).toBe(tenant.tenantId);
  });
});

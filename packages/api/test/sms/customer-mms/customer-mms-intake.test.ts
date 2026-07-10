/**
 * U2 — customer MMS-to-quote intake unit tests (mocked gateway/repos).
 *
 * Covers the customer-resolution branch the vision task can't: a known
 * customer drafts against the resolved record; an unknown sender creates a
 * new (prefilled) customer; a phone shared by 2+ customers raises a
 * clarification and drafts NOTHING (never a silent guess); a vision parse
 * failure notifies the owner without persisting a proposal. Also pins that
 * photos are stored + presigned before the gateway is called, and that the
 * persisted proposal + audit carry the tenant.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ingestCustomerMms,
  CUSTOMER_MMS_ACTOR,
  CUSTOMER_MMS_PARSE_FALLBACK_NOTICE,
  type CustomerMmsIntakeDeps,
} from '../../../src/sms/customer-mms/customer-mms-intake';
import type { InboundSmsContext } from '../../../src/sms/inbound-dispatch';
import {
  InMemoryCustomerRepository,
  createCustomer,
  type CustomerRepository,
} from '../../../src/customers/customer';
import { InMemoryProposalRepository } from '../../../src/proposals/proposal';
import { InMemoryFileRepository, type StorageProvider } from '../../../src/files/file-service';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import {
  createCatalogItem,
  InMemoryCatalogItemRepository,
} from '../../../src/catalog/catalog-item';
import type { LLMGateway, LLMResponse } from '../../../src/ai/gateway/gateway';

const TENANT = 'tenant-1';
const CUSTOMER_PHONE = '+15125550199';

function ctx(overrides: Partial<InboundSmsContext> = {}): InboundSmsContext {
  return {
    tenantId: TENANT,
    fromE164: CUSTOMER_PHONE,
    body: 'Can you fix this?',
    messageSid: 'SM-cust-1',
    media: [{ url: 'https://api.twilio.com/media/ME1', contentType: 'image/jpeg' }],
    ...overrides,
  };
}

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

function makeStorage(): StorageProvider & {
  putObject: ReturnType<typeof vi.fn>;
  generateDownloadUrl: ReturnType<typeof vi.fn>;
} {
  return {
    generateUploadUrl: vi.fn(async () => 'https://upload'),
    generateDownloadUrl: vi.fn(async (_b: string, key: string) => `https://presigned/${key}`),
    getObjectMetadata: vi.fn(async () => null),
    getObject: vi.fn(async () => null),
    putObject: vi.fn(async (): Promise<void> => undefined),
    deleteObject: vi.fn(async (): Promise<void> => undefined),
  } as unknown as StorageProvider & {
    putObject: ReturnType<typeof vi.fn>;
    generateDownloadUrl: ReturnType<typeof vi.fn>;
  };
}

const validVisionJson = JSON.stringify({
  lineItems: [{ description: 'Drywall patch', quantity: 1, unitPrice: 18000, category: 'labor' }],
  notes: 'Hole near the outlet.',
  confidence_score: 0.7,
});

describe('U2 — ingestCustomerMms', () => {
  let customerRepo: InMemoryCustomerRepository;
  let proposalRepo: InMemoryProposalRepository;
  let fileRepo: InMemoryFileRepository;
  let auditRepo: InMemoryAuditRepository;
  let storage: ReturnType<typeof makeStorage>;
  let fetchMedia: ReturnType<typeof vi.fn>;
  let notifyOwner: ReturnType<typeof vi.fn>;
  let baseDeps: CustomerMmsIntakeDeps;

  beforeEach(() => {
    customerRepo = new InMemoryCustomerRepository();
    proposalRepo = new InMemoryProposalRepository();
    fileRepo = new InMemoryFileRepository();
    auditRepo = new InMemoryAuditRepository();
    storage = makeStorage();
    fetchMedia = vi.fn(async () => ({
      bytes: Buffer.from('jpeg'),
      contentType: 'image/jpeg',
    })) as ReturnType<typeof vi.fn>;
    notifyOwner = vi.fn(async (): Promise<void> => undefined) as ReturnType<typeof vi.fn>;
    baseDeps = {
      customerRepo,
      proposalRepo,
      fileRepo,
      storage,
      storageBucket: 'test-bucket',
      fetchMedia: fetchMedia as unknown as CustomerMmsIntakeDeps['fetchMedia'],
      gateway: gatewayReturning(validVisionJson),
      auditRepo,
      notifyOwner: notifyOwner as unknown as CustomerMmsIntakeDeps['notifyOwner'],
    };
  });

  async function seedCustomer(phone: string, name: string): Promise<string> {
    const c = await createCustomer(
      {
        tenantId: TENANT,
        firstName: name,
        lastName: '',
        primaryPhone: phone,
        createdBy: 'seed',
      },
      customerRepo as CustomerRepository,
    );
    return c.id;
  }

  it('known customer → draft_estimate proposal grounded against catalog, persisted with tenant', async () => {
    const customerId = await seedCustomer(CUSTOMER_PHONE, 'Jenna');
    const catalogRepo = new InMemoryCatalogItemRepository();
    await catalogRepo.create(
      createCatalogItem({
        tenantId: TENANT,
        name: 'Drywall patch',
        category: 'Labor',
        unit: 'each',
        unitPriceCents: 15000,
      }),
    );

    const result = await ingestCustomerMms(ctx(), { ...baseDeps, catalogRepo });

    expect(result.outcome).toBe('drafted');
    expect(result.customerId).toBe(customerId);
    const stored = await proposalRepo.findById(TENANT, result.proposalId!);
    expect(stored).not.toBeNull();
    expect(stored!.proposalType).toBe('draft_estimate');
    expect(stored!.tenantId).toBe(TENANT);
    expect(stored!.payload.customerId).toBe(customerId);
    const lineItems = stored!.payload.lineItems as Array<Record<string, unknown>>;
    expect(lineItems[0].unitPrice).toBe(15000); // catalog price, not the model's 18000
    expect(stored!.status).not.toBe('approved'); // never auto-issued
    // Audit emitted for the draft.
    const events = auditRepo.getAll().filter((e) => e.eventType === 'customer_mms.estimate_drafted');
    expect(events).toHaveLength(1);
    expect(events[0].tenantId).toBe(TENANT);
  });

  it('security — a high injected confidence_score cannot auto-approve a customer-MMS estimate, even with supervisorPresent=true', async () => {
    // The photo + caption are fully caller-controlled, so the model's
    // self-reported confidence_score is an injection surface. This async channel
    // forces supervisorPresent=false, so the draft must land in human review
    // regardless of confidence or a nominally-present supervisor.
    await seedCustomer(CUSTOMER_PHONE, 'Jenna');
    const catalogRepo = new InMemoryCatalogItemRepository();
    await catalogRepo.create(
      createCatalogItem({
        tenantId: TENANT,
        name: 'Drywall patch',
        category: 'Labor',
        unit: 'each',
        unitPriceCents: 15000,
      }),
    );
    const injectedHighConfidence = JSON.stringify({
      lineItems: [{ description: 'Drywall patch', quantity: 1, unitPrice: 15000, category: 'labor' }],
      notes: 'x',
      confidence_score: 0.99,
    });

    const result = await ingestCustomerMms(ctx(), {
      ...baseDeps,
      catalogRepo,
      gateway: gatewayReturning(injectedHighConfidence),
      supervisorPresent: true,
    });

    const stored = await proposalRepo.findById(TENANT, result.proposalId!);
    expect(stored).not.toBeNull();
    expect(stored!.status).not.toBe('approved');
    expect(['ready_for_review', 'draft']).toContain(stored!.status);
  });

  it('stores + presigns the photo BEFORE the gateway call (image URL passed to task)', async () => {
    await seedCustomer(CUSTOMER_PHONE, 'Jenna');
    const result = await ingestCustomerMms(ctx(), baseDeps);

    expect(result.outcome).toBe('drafted');
    expect(storage.putObject).toHaveBeenCalledTimes(1);
    expect(storage.generateDownloadUrl).toHaveBeenCalledTimes(1);
    const completeMock = (baseDeps.gateway as unknown as { complete: ReturnType<typeof vi.fn> })
      .complete;
    const req = completeMock.mock.calls[0][0];
    const parts = (req.messages[1].parts ?? []) as Array<{ type: string; url?: string }>;
    const img = parts.find((p) => p.type === 'image');
    expect(img?.url).toMatch(/^https:\/\/presigned\//);
  });

  it('unknown sender → creates a new prefilled customer and drafts against it', async () => {
    const result = await ingestCustomerMms(ctx(), baseDeps);

    expect(result.outcome).toBe('drafted');
    expect(result.customerId).toBeDefined();
    const created = await customerRepo.findById(TENANT, result.customerId!);
    expect(created).not.toBeNull();
    expect(created!.primaryPhone).toBe(CUSTOMER_PHONE);
    expect(created!.createdBy).toBe(CUSTOMER_MMS_ACTOR);
    // createCustomer emits its own customer.created audit.
    const createdEvents = auditRepo.getAll().filter((e) => e.eventType === 'customer.created');
    expect(createdEvents).toHaveLength(1);
  });

  it('ambiguous (phone shared by 2+ customers) → clarification proposal, NO estimate', async () => {
    await seedCustomer(CUSTOMER_PHONE, 'Alice');
    await seedCustomer(CUSTOMER_PHONE, 'Bob');

    const result = await ingestCustomerMms(ctx(), baseDeps);

    expect(result.outcome).toBe('clarification');
    const stored = await proposalRepo.findById(TENANT, result.proposalId!);
    expect(stored!.proposalType).toBe('voice_clarification');
    expect((stored!.payload as { reason: string }).reason).toBe('ambiguous_entity');
    expect(stored!.status).not.toBe('approved');
    // No photo was fetched/stored and no draft_estimate exists.
    expect(fetchMedia).not.toHaveBeenCalled();
    const all = await proposalRepo.findByTenant(TENANT);
    expect(all.some((p) => p.proposalType === 'draft_estimate')).toBe(false);
    // Gateway never called — we don't draft an estimate for an ambiguous sender.
    const completeMock = (baseDeps.gateway as unknown as { complete: ReturnType<typeof vi.fn> })
      .complete;
    expect(completeMock).not.toHaveBeenCalled();
  });

  it('vision parse failure → owner notice, no proposal persisted', async () => {
    await seedCustomer(CUSTOMER_PHONE, 'Jenna');
    const result = await ingestCustomerMms(ctx(), {
      ...baseDeps,
      gateway: gatewayReturning('not json at all'),
    });

    expect(result.outcome).toBe('parse_failed');
    expect(notifyOwner).toHaveBeenCalledWith(TENANT, CUSTOMER_MMS_PARSE_FALLBACK_NOTICE);
    const all = await proposalRepo.findByTenant(TENANT);
    expect(all.some((p) => p.proposalType === 'draft_estimate')).toBe(false);
  });

  it('no media → ignored', async () => {
    const result = await ingestCustomerMms(ctx({ media: [] }), baseDeps);
    expect(result.outcome).toBe('ignored_no_media');
  });

  it('all media unstorable (fetch returns null) → no_storable_media, customer still created', async () => {
    const result = await ingestCustomerMms(ctx(), {
      ...baseDeps,
      fetchMedia: vi.fn(async () => null) as unknown as CustomerMmsIntakeDeps['fetchMedia'],
    });
    expect(result.outcome).toBe('no_storable_media');
    expect(result.customerId).toBeDefined();
    const all = await proposalRepo.findByTenant(TENANT);
    expect(all.some((p) => p.proposalType === 'draft_estimate')).toBe(false);
  });
});

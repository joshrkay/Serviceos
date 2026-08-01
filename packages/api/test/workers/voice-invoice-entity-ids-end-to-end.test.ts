/**
 * END-TO-END: a spoken invoice request, from the microphone to the `invoices`
 * row — and the model's invented entity ids, proven never to get there.
 *
 * WHY THIS FILE EXISTS, AND WHY IT LOOKS LIKE THIS
 * -----------------------------------------------
 * Every voice bug found on 2026-07-27/28 had the same shape: a field was
 * silently dropped (or silently fabricated) by an intermediate layer that
 * rebuilt an object from scratch, and every layer's own unit tests stayed
 * green because each hand-fed the layer under test the very thing that layer
 * was mishandling. One fix shipped green and did nothing live.
 *
 * `customerId` on a drafted invoice has to survive FIVE independent hops to
 * reach a write, and be REFUSED at the last one if it was invented:
 *
 *   scriptHermeticResponse()            ← the mock classifier the corpus grades
 *     → entitiesForProposal()           ← the router entity allowlist
 *     → resolveVoiceEntityReferences()  ← plans the lookup, owns the refKey
 *                                         mapping (customerName → customerId)
 *     → INTENT_TO_PROPOSAL_TYPE         ← create_invoice → draft_invoice
 *     → InvoiceTaskHandler.handle()     ← authors the id from the resolver
 *     → validateProposalPayload()       ← the contract gate
 *     → decideInitialStatus()           ← the missingFields → 'draft' gate
 *     → ProposalExecutor + createExecutionHandlerRegistry()
 *                                       ← the PRODUCTION registry, so a
 *                                         forgotten `customerRepo` fails here
 *     → CreateInvoiceExecutionHandler   ← the tenant existence check
 *     → invoices / jobs                 ← the actual write
 *
 * Nothing between those layers is stubbed. Two things are supplied as INPUT,
 * because they are the inputs: (1) the drafting model's JSON, in the
 * hallucinating tests, taken verbatim from what Development actually returned —
 * that IS the bug being reproduced; and (2) an `EntityResolver` backed by the
 * same in-memory tenant repositories the executor later writes to, because the
 * production resolvers (PgEntityResolver / AliasFirstEntityResolver) need a
 * live `pg.Pool`. The REAL `resolveVoiceEntityReferences` still runs on top of
 * it, so the layer that actually drops things — lookup planning and the
 * `refKey` mapping — is exercised, and the id it produces is the id the write
 * is checked against.
 *
 * Do NOT rely on the voice-quality corpus for any of this: all 570 cassette
 * entries are `provider: "mock"`, replaying regex from ai/providers/mock.ts.
 */
import { describe, it, expect } from 'vitest';
import { entitiesForProposal } from '../../src/workers/voice-action-router';
import { INTENT_TO_PROPOSAL_TYPE } from '../../src/proposals/voice-intent-map';
import { resolveVoiceEntityReferences } from '../../src/ai/agents/customer-calling/entity-resolution';
import type {
  EntityResolver,
  EntityResolverResult,
} from '../../src/ai/resolution/entity-resolver';
import { scriptHermeticResponse, MockLLMProvider } from '../../src/ai/providers/mock';
import { InvoiceTaskHandler } from '../../src/ai/tasks/invoice-task';
import { LLMGateway } from '../../src/ai/gateway/gateway';
import type { LLMProvider, LLMGatewayConfig, LLMRequest } from '../../src/ai/gateway/gateway';
import { StubProvider } from '../../src/ai/gateway/providers';
import type { ExtractedEntities } from '../../src/ai/orchestration/intent-classifier';
import { validateProposalPayload } from '../../src/proposals/contracts';
import {
  InMemoryProposalRepository,
  Proposal,
  ProposalType,
} from '../../src/proposals/proposal';
import { transitionProposal, UNDO_WINDOW_MS } from '../../src/proposals/lifecycle';
import { InMemoryProposalExecutionRepository } from '../../src/proposals/proposal-execution';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import {
  createExecutionHandlerRegistry,
  ExecutionHandler,
} from '../../src/proposals/execution/handlers';
import { InMemoryCustomerRepository, createCustomer } from '../../src/customers/customer';
import { InMemoryLocationRepository, createLocation } from '../../src/locations/location';
import { InMemoryJobRepository } from '../../src/jobs/job';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { InMemorySettingsRepository, TenantSettings } from '../../src/settings/settings';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import {
  InMemoryCatalogItemRepository,
  createCatalogItem,
} from '../../src/catalog/catalog-item';

const TENANT = '11111111-1111-4111-8111-111111111111';
const APPROVER = '22222222-2222-4222-8222-222222222222';

/** RFC 4122 §C.1 example uuid — well-formed, references nothing. */
const RFC_EXAMPLE_UUID = '123e4567-e89b-12d3-a456-426614174000';

/** Verbatim from the Development database, all three observed values. */
const HALLUCINATED = ['unknown', '<uuid>', RFC_EXAMPLE_UUID];

const TRANSCRIPT = 'Draft an invoice for Marcus Holloway for the water heater install.';

// ─── Layer 1 — the mock provider the voice-quality corpus actually replays ──
function classify(transcript: string): { intentType: string; entities: ExtractedEntities } {
  const req = {
    taskType: 'classify_intent',
    messages: [{ role: 'user', content: transcript }],
  } as unknown as LLMRequest;
  const out = JSON.parse(scriptHermeticResponse(req));
  return { intentType: out.intentType, entities: out.extractedEntities };
}

interface Wiring {
  proposalRepo: InMemoryProposalRepository;
  customerRepo: InMemoryCustomerRepository;
  locationRepo: InMemoryLocationRepository;
  jobRepo: InMemoryJobRepository;
  invoiceRepo: InMemoryInvoiceRepository;
  auditRepo: InMemoryAuditRepository;
  executor: ProposalExecutor;
  resolver: EntityResolver;
  customerId: string;
}

/**
 * Production wiring, not a hand-built handler map: the registry is where
 * `customerRepo` is threaded into CreateInvoiceExecutionHandler, so a registry
 * that forgets to pass it must fail here too.
 */
async function wire(): Promise<Wiring> {
  const proposalRepo = new InMemoryProposalRepository();
  const executionRepo = new InMemoryProposalExecutionRepository();
  const customerRepo = new InMemoryCustomerRepository();
  const locationRepo = new InMemoryLocationRepository();
  const jobRepo = new InMemoryJobRepository();
  const invoiceRepo = new InMemoryInvoiceRepository();
  const auditRepo = new InMemoryAuditRepository();

  const settingsRepo = new InMemorySettingsRepository();
  const settings: TenantSettings = {
    id: 'settings-1',
    tenantId: TENANT,
    businessName: 'Test Co',
    timezone: 'UTC',
    estimatePrefix: 'EST-',
    invoicePrefix: 'INV-',
    nextEstimateNumber: 1,
    nextInvoiceNumber: 1,
    defaultPaymentTermDays: 30,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await settingsRepo.create(settings);

  // The real tenant record the spoken name has to resolve to.
  const customer = await createCustomer(
    { tenantId: TENANT, firstName: 'Marcus', lastName: 'Holloway', createdBy: APPROVER },
    customerRepo,
  );
  await createLocation(
    {
      tenantId: TENANT,
      customerId: customer.id,
      street1: '400 Kettle Road',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      isPrimary: true,
    },
    locationRepo,
  );

  // Resolver over the SAME repositories the executor writes to, so a
  // cross-layer key mismatch cannot hide behind a hand-written id.
  const resolver: EntityResolver = {
    async resolve(input): Promise<EntityResolverResult> {
      if (input.kind !== 'customer') return { kind: 'skipped' };
      const matches = await customerRepo.search(input.tenantId, input.reference);
      if (matches.length === 0) return { kind: 'not_found' };
      if (matches.length > 1) {
        return {
          kind: 'ambiguous',
          candidates: matches.map((m) => ({
            id: m.id,
            label: m.displayName,
            kind: 'customer' as const,
            score: 0.9,
          })),
        };
      }
      return {
        kind: 'resolved',
        candidate: {
          id: matches[0].id,
          label: matches[0].displayName,
          kind: 'customer' as const,
          score: 1,
        },
      };
    },
  };

  const handlers = createExecutionHandlerRegistry({
    invoiceRepo,
    settingsRepo,
    customerRepo,
    locationRepo,
    jobRepo,
    auditRepo,
  }) as Map<ProposalType, ExecutionHandler>;

  const guard = new IdempotencyGuard(executionRepo, proposalRepo);
  const executor = new ProposalExecutor(handlers, proposalRepo, guard, auditRepo);
  return {
    proposalRepo,
    customerRepo,
    locationRepo,
    jobRepo,
    invoiceRepo,
    auditRepo,
    executor,
    resolver,
    customerId: customer.id,
  };
}

function groundedCatalog(): InMemoryCatalogItemRepository {
  const repo = new InMemoryCatalogItemRepository();
  void repo.create(
    createCatalogItem({
      tenantId: TENANT,
      name: 'Water heater install',
      category: 'Labor',
      unit: 'each',
      unitPriceCents: 185_000,
    }),
  );
  return repo;
}

/** Gateway over the REAL hermetic mock provider (the corpus's own model). */
function hermeticGateway(): LLMGateway {
  const providers = new Map<string, LLMProvider>();
  providers.set('mock', new MockLLMProvider('{}', { hermetic: true }));
  const config: LLMGatewayConfig = { defaultProvider: 'mock', defaultModel: 'mock-model' };
  return new LLMGateway(config, providers);
}

/** Gateway replaying the model output Development actually produced. */
function hallucinatingGateway(ids: Record<string, string>): LLMGateway {
  const stub = new StubProvider('stub');
  stub.setResponse({
    content: JSON.stringify({
      ...ids,
      lineItems: [{ description: 'Water heater install', quantity: 1, unitPrice: 185_000 }],
      confidence_score: 0.95,
    }),
  });
  const providers = new Map<string, LLMProvider>();
  providers.set('stub', stub);
  const config: LLMGatewayConfig = { defaultProvider: 'stub', defaultModel: 'test-model' };
  return new LLMGateway(config, providers);
}

/**
 * Layers 1→6: transcript → drafted proposal, through the router allowlist, the
 * real entity-resolution layer, the intent map and the task handler.
 */
async function draftFromTranscript(
  w: Wiring,
  gateway: LLMGateway,
  transcript = TRANSCRIPT,
): Promise<Proposal> {
  // Layer 1 — classifier.
  const { intentType, entities } = classify(transcript);
  expect(intentType).toBe('create_invoice');

  // Layer 2 — the router entity allowlist.
  const forwarded = entitiesForProposal(
    intentType as Exclude<Parameters<typeof entitiesForProposal>[0], never>,
    entities,
  );

  // Layer 3 — the REAL resolution layer: it plans the lookup for this intent
  // and owns the customerName → customerId refKey mapping.
  const annotation = await resolveVoiceEntityReferences(w.resolver, {
    tenantId: TENANT,
    intent: intentType,
    entities: forwarded,
  });
  expect(annotation.kind).toBe('ok');
  const resolved = (annotation as { resolved: Record<string, string> }).resolved;

  // Layer 4 — the single intent→proposalType map.
  const proposalType = INTENT_TO_PROPOSAL_TYPE[intentType as 'create_invoice'];
  expect(proposalType).toBe('draft_invoice');

  // Layer 5 — the task handler, fed exactly the context voice-action-router
  // builds (entities plus the resolver's verified ids).
  const handler = new InvoiceTaskHandler(gateway, groundedCatalog());
  const { proposal } = await handler.handle({
    tenantId: TENANT,
    userId: 'voice_agent',
    message: transcript,
    conversationId: '33333333-3333-4333-8333-333333333333',
    existingEntities: {
      ...forwarded,
      ...(resolved.customerId ? { customerId: resolved.customerId } : {}),
      ...(resolved.jobId ? { jobId: resolved.jobId } : {}),
    },
    ...(resolved.customerId ? { customerId: resolved.customerId } : {}),
    supervisorPresent: true,
  });
  return proposal;
}

/** Approve + execute exactly as the approve route does. */
async function approveAndExecute(w: Wiring, proposal: Proposal) {
  await w.proposalRepo.create(proposal);
  const stored = await w.proposalRepo.findById(TENANT, proposal.id);
  let approved = stored!.status === 'approved' ? stored! : transitionProposal(stored!, 'ready_for_review', APPROVER);
  if (approved.status !== 'approved') approved = transitionProposal(approved, 'approved', APPROVER);
  // Backdate past the undo window so the executor runs immediately.
  approved = { ...approved, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };
  await w.proposalRepo.update(TENANT, proposal.id, approved);
  const { result } = await w.executor.execute(approved, {
    tenantId: TENANT,
    executedBy: APPROVER,
  });
  return result;
}

describe('spoken invoice, microphone → invoices (nothing stubbed between layers)', () => {
  it('the resolved customer survives every layer and an invoice is written against it', async () => {
    const w = await wire();
    // The REAL hermetic mock provider drafts this one — the same function the
    // 570-entry voice-quality corpus replays.
    const drafted = await draftFromTranscript(w, hermeticGateway());

    // Layer 5 output: the id came from the resolver, matched against the real
    // customer row — not from the model, and not hand-written here.
    expect(drafted.payload.customerId).toBe(w.customerId);
    expect(drafted.payload.customerReference).toBeUndefined();

    // Layer 6: the contract gate accepts it.
    expect(validateProposalPayload('draft_invoice', drafted.payload).valid).toBe(true);

    // Layers 8–10: approve → executor → production registry → repositories.
    const result = await approveAndExecute(w, drafted);
    expect(result.success).toBe(true);

    const invoice = await w.invoiceRepo.findById(TENANT, result.resultEntityId!);
    expect(invoice).not.toBeNull();
    expect(invoice!.invoiceNumber).toMatch(/^INV-/);

    // No jobId was spoken, so B6's auto-open ran — against the RESOLVED
    // customer, which is the whole point of authoring the id upstream.
    const jobs = await w.jobRepo.findByTenant(TENANT);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].customerId).toBe(w.customerId);
    expect(invoice!.jobId).toBe(jobs[0].id);
  });

  for (const garbage of HALLUCINATED) {
    it(`a model-invented customerId (${garbage}) never reaches the invoice write`, async () => {
      const w = await wire();
      const drafted = await draftFromTranscript(
        w,
        hallucinatingGateway({ customerId: garbage, jobId: garbage }),
      );

      // The resolver's id wins at layer 5; the model's is gone entirely.
      expect(drafted.payload.customerId).toBe(w.customerId);
      expect(drafted.payload.jobId).toBeUndefined();
      expect(JSON.stringify(drafted.payload)).not.toContain(garbage);

      const result = await approveAndExecute(w, drafted);
      expect(result.success).toBe(true);

      // The persisted invoice is attached to the REAL customer's job.
      const jobs = await w.jobRepo.findByTenant(TENANT);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].customerId).toBe(w.customerId);
    });
  }

  it('an UNRESOLVABLE spoken name never produces an invoice — it is drafted and gated', async () => {
    // The live failure mode: nobody in the tenant matches, the model supplies
    // the RFC example uuid, and `z.string().uuid()` waves it through. This is
    // the case that must not end in a written invoice.
    const w = await wire();
    const transcript = 'Draft an invoice for Delphine Okonkwo for the water heater install.';
    const drafted = await draftFromTranscript(
      w,
      hallucinatingGateway({ customerId: RFC_EXAMPLE_UUID }),
      transcript,
    );

    // No fabricated id; the spoken name rides as a reference instead.
    expect(drafted.payload.customerId).toBeUndefined();
    expect(drafted.payload.customerReference).toBeTruthy();
    expect(JSON.stringify(drafted.payload)).not.toContain('123e4567');

    // Still a VALID payload (the customerId-or-customerReference refine)…
    expect(validateProposalPayload('draft_invoice', drafted.payload).valid).toBe(true);
    // …but forced to 'draft' by missingFields, so it cannot auto-approve
    // despite model confidence 0.95, a catalog-grounded line and a present
    // supervisor.
    expect(drafted.status).toBe('draft');
    expect((drafted.sourceContext as Record<string, unknown>).missingFields).toContain(
      'customerId',
    );

    // And if an operator force-approves it anyway, execution refuses: no
    // invoice, no job.
    const result = await approveAndExecute(w, drafted);
    expect(result.success).toBe(false);
    expect(await w.invoiceRepo.findByTenant(TENANT)).toHaveLength(0);
    expect(await w.jobRepo.findByTenant(TENANT)).toHaveLength(0);
  });

  it('a well-formed but non-existent customerId injected downstream is refused at the write', async () => {
    // Defence in depth: the drafting handler is not the only entry point (the
    // assistant route, SMS, a re-draft, and `editProposal` can all put a
    // customerId on a payload). The execution handler is the last chokepoint
    // before money is attached, and it must refuse on its own.
    const w = await wire();
    const drafted = await draftFromTranscript(w, hermeticGateway());
    const tampered: Proposal = {
      ...drafted,
      id: '44444444-4444-4444-8444-444444444444',
      payload: { ...drafted.payload, customerId: RFC_EXAMPLE_UUID },
    };
    // It passes the schema — that is the point.
    expect(validateProposalPayload('draft_invoice', tampered.payload).valid).toBe(true);

    const result = await approveAndExecute(w, tampered);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/does not exist in this tenant/i);
    expect(await w.invoiceRepo.findByTenant(TENANT)).toHaveLength(0);
    expect(await w.jobRepo.findByTenant(TENANT)).toHaveLength(0);
  });

  it('a well-formed but non-existent jobId injected downstream is refused at the write', async () => {
    const w = await wire();
    const drafted = await draftFromTranscript(w, hermeticGateway());
    const tampered: Proposal = {
      ...drafted,
      id: '55555555-5555-4555-8555-555555555555',
      payload: { ...drafted.payload, jobId: RFC_EXAMPLE_UUID },
    };
    expect(validateProposalPayload('draft_invoice', tampered.payload).valid).toBe(true);

    const result = await approveAndExecute(w, tampered);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/job .* does not exist in this tenant/i);
    expect(await w.invoiceRepo.findByTenant(TENANT)).toHaveLength(0);
  });

  /**
   * The generalizable guard against the allowlist failure mode.
   * `entitiesForProposal` is the layer that silently destroyed the spoken
   * address on the create_customer path. Pin that it passes an invoice turn's
   * entities through untouched, so the next added field cannot vanish here.
   */
  it('entitiesForProposal forwards a create_invoice turn verbatim', () => {
    const entities: ExtractedEntities = {
      customerName: 'Marcus Holloway',
      jobReference: 'the water heater job',
    };
    expect(entitiesForProposal('create_invoice', entities)).toBe(entities);
  });

  it('the hermetic mock classifier really does emit customerName for an invoice turn', () => {
    // The corpus grades scriptHermeticResponse's output, not a real model's.
    // A field the mock cannot emit is a field the corpus can never grade —
    // which is how the dropped address cleared the launch gate.
    const { intentType, entities } = classify(TRANSCRIPT);
    expect(intentType).toBe('create_invoice');
    expect(entities.customerName).toContain('Marcus Holloway');
  });
});

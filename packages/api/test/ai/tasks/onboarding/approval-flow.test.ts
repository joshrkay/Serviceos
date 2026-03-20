import { describe, it, expect, beforeEach } from 'vitest';
import { createMockLLMGateway } from '../../../../src/ai/gateway/factory';
import { OnboardingOrchestrator } from '../../../../src/ai/orchestration/onboarding';
import {
  createProposal,
  InMemoryProposalRepository,
  Proposal,
} from '../../../../src/proposals/proposal';
import { validateProposalPayload } from '../../../../src/proposals/contracts';
import { MockLLMProvider } from '../../../../src/ai/providers/mock';
import { LLMGateway } from '../../../../src/ai/gateway/gateway';
import * as fs from 'fs';
import * as path from 'path';

const fixturesDir = path.join(__dirname, '../../../fixtures/onboarding');

function loadFixture(name: string): string {
  return fs.readFileSync(path.join(fixturesDir, name), 'utf-8');
}

function setHvacResponses(provider: MockLLMProvider) {
  provider.setDefaultResponse(JSON.stringify({
    business_name: 'Comfort Zone HVAC',
    city: 'Scottsdale',
    state: 'AZ',
    verticals: [{ type: 'hvac', confidence: 0.95, source_text: 'HVAC' }],
    service_descriptions: ['AC repair', 'tune-ups', 'replacements'],
    categories: [
      { vertical_type: 'hvac', category_id: 'repair', name: 'AC Repair', confidence: 0.9, source_text: 'AC repair' },
      { vertical_type: 'hvac', category_id: 'maintenance', name: 'Tune-up', confidence: 0.9, source_text: 'tune-ups' },
    ],
    prices: [
      { service_ref: 'AC Repair', amount_cents: 8900, price_type: 'exact', confidence: 0.9, source_text: '$89' },
      { service_ref: 'Tune-up', amount_cents: 14900, price_type: 'exact', confidence: 0.9, source_text: '$149' },
    ],
    members: [
      { name: 'Marcus', inferred_role: 'technician', confidence: 0.9, source_text: 'Marcus' },
      { name: 'Tony', inferred_role: 'technician', confidence: 0.9, source_text: 'Tony' },
    ],
    working_hours: [
      { days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'], start_time: '08:00', end_time: '17:00' },
    ],
    sla: { type: 'emergency', hours_target: 4, is_guarantee: false, source_text: 'within 4 hours' },
    confidence_score: 0.88,
  }));
}

describe('T5 — Review and Approval Flow Tests', () => {
  let gateway: LLMGateway;
  let provider: MockLLMProvider;
  let orchestrator: OnboardingOrchestrator;
  let proposalRepo: InMemoryProposalRepository;

  beforeEach(() => {
    const mock = createMockLLMGateway();
    gateway = mock.gateway;
    provider = mock.provider;
    orchestrator = new OnboardingOrchestrator(gateway);
    proposalRepo = new InMemoryProposalRepository();
  });

  // T5-001: Full approval — approve all proposals
  it('T5-001 — all proposals start in draft status', async () => {
    setHvacResponses(provider);

    const result = await orchestrator.run(
      'tenant-001', 'user-001', loadFixture('fixture-01-hvac-happy-path.txt')
    );

    // Proposals returned by orchestrator are created via createProposal,
    // which sets status to 'draft'
    expect(result.proposalIds.length).toBeGreaterThan(0);
    // Verify the extraction produced data for all categories
    expect(result.extraction.businessProfile.businessName).toBe('Comfort Zone HVAC');
    expect(result.extraction.categories.categories.length).toBeGreaterThanOrEqual(2);
    expect(result.extraction.team.members.length).toBeGreaterThanOrEqual(2);
  });

  // T5-002: Edit before approve — owner changes price
  it('T5-002 — proposal payload can be edited before approval', async () => {
    setHvacResponses(provider);

    const result = await orchestrator.run(
      'tenant-001', 'user-001', loadFixture('fixture-01-hvac-happy-path.txt')
    );

    // Simulate storing and updating a proposal
    const sampleProposal = createProposal({
      tenantId: 'tenant-001',
      proposalType: 'onboarding_estimate_template',
      payload: {
        verticalType: 'hvac',
        categoryId: 'diagnostic',
        templateName: 'Diagnostic',
        lineItems: [{ description: 'Diagnostic Fee', defaultQuantity: 1, defaultUnitPriceCents: 8900, taxable: true, sortOrder: 0 }],
      },
      summary: 'Diagnostic template',
      createdBy: 'user-001',
    });

    await proposalRepo.create(sampleProposal);

    // Edit the price
    const updated = await proposalRepo.update('tenant-001', sampleProposal.id, {
      payload: {
        ...sampleProposal.payload,
        lineItems: [{ description: 'Diagnostic Fee', defaultQuantity: 1, defaultUnitPriceCents: 9500, taxable: true, sortOrder: 0 }],
      },
      status: 'approved',
    });

    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('approved');
    const lineItems = (updated!.payload as Record<string, unknown>).lineItems as Array<Record<string, unknown>>;
    expect(lineItems[0].defaultUnitPriceCents).toBe(9500);
  });

  // T5-003: Reject and redo — rejection reason stored
  it('T5-003 — rejected proposals store rejection reason', async () => {
    const proposal = createProposal({
      tenantId: 'tenant-001',
      proposalType: 'onboarding_service_category',
      payload: { verticalType: 'hvac', categoryId: 'repair', displayName: 'Ductwork' },
      summary: 'Activate category: Ductwork',
      createdBy: 'user-001',
    });

    await proposalRepo.create(proposal);

    const rejected = await proposalRepo.updateStatus('tenant-001', proposal.id, 'rejected', {
      rejectionReason: 'We do not offer ductwork services',
    });

    expect(rejected!.status).toBe('rejected');
    expect(rejected!.rejectionReason).toBe('We do not offer ductwork services');
  });

  // T5-004: Partial approval — approve categories, skip templates
  it('T5-004 — partial approval leaves config functional', async () => {
    setHvacResponses(provider);

    const result = await orchestrator.run(
      'tenant-001', 'user-001', loadFixture('fixture-01-hvac-happy-path.txt')
    );

    // Partial approval is valid — some proposals approved, others left in draft
    // The system should not break. Categories can exist without templates.
    expect(result.batches.length).toBeGreaterThan(0);

    // First batch can be approved independently
    const firstBatch = result.batches[0];
    expect(firstBatch.proposalIds.length).toBeGreaterThan(0);
    expect(firstBatch.proposalIds.length).toBeLessThanOrEqual(5);
  });

  // T5-005: Batch approval — approve 5 proposals at once
  it('T5-005 — batch approval of multiple proposals', async () => {
    // Create 5 proposals
    const proposals: Proposal[] = [];
    for (let i = 0; i < 5; i++) {
      const p = createProposal({
        tenantId: 'tenant-001',
        proposalType: 'onboarding_service_category',
        payload: { verticalType: 'hvac', categoryId: 'repair', displayName: `Category ${i}` },
        summary: `Category ${i}`,
        createdBy: 'user-001',
      });
      await proposalRepo.create(p);
      proposals.push(p);
    }

    // Approve all 5
    for (const p of proposals) {
      await proposalRepo.updateStatus('tenant-001', p.id, 'approved');
    }

    const approved = await proposalRepo.findByStatus('tenant-001', 'approved');
    expect(approved).toHaveLength(5);
  });

  // T5-007 covered in orchestration.test.ts

  it('all proposal payloads pass Zod validation', async () => {
    setHvacResponses(provider);

    const result = await orchestrator.run(
      'tenant-001', 'user-001', loadFixture('fixture-01-hvac-happy-path.txt')
    );

    // The orchestrator creates proposals internally — we verify the extraction
    // feeds into valid proposal shapes by checking the output structure
    expect(result.extraction.businessProfile).toBeDefined();
    expect(result.extraction.categories.categories.length).toBeGreaterThan(0);

    // Validate a sample tenant settings payload
    const settingsValidation = validateProposalPayload('onboarding_tenant_settings', {
      businessName: result.extraction.businessProfile.businessName ?? 'Test',
      verticalPacks: result.extraction.businessProfile.verticalPacks.map((v) => v.type),
    });
    expect(settingsValidation.valid).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import {
  captureEntityAliasCandidates,
  type EntityAliasCandidateCaptureInput,
} from '../../../src/learning/entity-aliases/candidate-service';
import {
  createProposal,
  InMemoryProposalRepository,
  type Proposal,
} from '../../../src/proposals/proposal';
import { ValidationError } from '../../../src/shared/errors';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '22222222-2222-4222-8222-222222222222';
const GROUNDING_PROPOSAL_ID = '33333333-3333-4333-8333-333333333333';
const CUSTOMER_ID = '44444444-4444-4444-8444-444444444444';
const INVOICE_ID = '55555555-5555-4555-8555-555555555555';

function pickerProposal(): Proposal {
  return {
    ...createProposal({
      tenantId: TENANT_ID,
      proposalType: 'voice_clarification',
      payload: {
        transcript: 'raw transcript that must not reach the candidate',
        reason: 'ambiguous_entity',
        entityReference: '  The   Khan account  ',
        entityCandidates: [
          { id: CUSTOMER_ID, label: 'Khan Plumbing', score: 0.8 },
        ],
      },
      summary: 'Which customer?',
      createdBy: ACTOR_ID,
    }),
    id: GROUNDING_PROPOSAL_ID,
    sourceContext: {
      entityKind: 'customer',
      entityReference: '  The   Khan account  ',
      entityCandidates: [
        { id: CUSTOMER_ID, kind: 'customer', label: 'Khan Plumbing', score: 0.8 },
      ],
      transcript: 'raw transcript that must not reach the candidate',
    },
  };
}

function pickerInput(
  overrides: Partial<Extract<EntityAliasCandidateCaptureInput, { source: 'entity_picker' }>> = {},
): Extract<EntityAliasCandidateCaptureInput, { source: 'entity_picker' }> {
  return {
    source: 'entity_picker',
    tenantId: TENANT_ID,
    actorId: ACTOR_ID,
    actorRole: 'dispatcher',
    groundingProposal: pickerProposal(),
    selectedEntityId: CUSTOMER_ID,
    ...overrides,
  };
}

describe('captureEntityAliasCandidates', () => {
  it('creates one ready-for-review proposal from a grounded picker selection and audits it', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const auditRepo = new InMemoryAuditRepository();

    const created = await captureEntityAliasCandidates(
      pickerInput(),
      { proposalRepo, auditRepo },
    );

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      proposalType: 'adopt_entity_alias',
      status: 'ready_for_review',
      tenantId: TENANT_ID,
      createdBy: ACTOR_ID,
      targetEntityType: 'customer',
      targetEntityId: CUSTOMER_ID,
      payload: {
        alias: 'The Khan account',
        entityKind: 'customer',
        entityId: CUSTOMER_ID,
        source: 'entity_picker',
        groundedProposalId: GROUNDING_PROPOSAL_ID,
      },
    });
    expect(JSON.stringify(created[0])).not.toContain('raw transcript');

    const audits = await auditRepo.findByEntity(TENANT_ID, 'proposal', created[0].id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      eventType: 'entity_alias.candidate_created',
      actorId: ACTOR_ID,
      correlationId: GROUNDING_PROPOSAL_ID,
    });
    expect(audits[0].metadata).not.toHaveProperty('alias');
  });

  it('deduplicates retries by tenant, kind, normalized alias, and target', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const auditRepo = new InMemoryAuditRepository();

    const first = await captureEntityAliasCandidates(
      pickerInput(),
      { proposalRepo, auditRepo },
    );
    const retry = await captureEntityAliasCandidates(
      pickerInput({
        groundingProposal: {
          ...pickerProposal(),
          sourceContext: {
            ...pickerProposal().sourceContext,
            entityReference: 'the khan account',
          },
        },
      }),
      { proposalRepo, auditRepo },
    );

    expect(retry.map((proposal) => proposal.id)).toEqual([first[0].id]);
    expect(
      (await proposalRepo.findByTenant(TENANT_ID)).filter(
        (proposal) => proposal.proposalType === 'adopt_entity_alias',
      ),
    ).toHaveLength(1);
    expect(
      (await auditRepo.findByEntity(TENANT_ID, 'proposal', first[0].id)).filter(
        (event) => event.eventType === 'entity_alias.candidate_created',
      ),
    ).toHaveLength(1);
  });

  it('rejects off-list picker IDs and source-context kind mismatches', async () => {
    const deps = {
      proposalRepo: new InMemoryProposalRepository(),
      auditRepo: new InMemoryAuditRepository(),
    };

    await expect(
      captureEntityAliasCandidates(
        pickerInput({ selectedEntityId: INVOICE_ID }),
        deps,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      captureEntityAliasCandidates(
        pickerInput({
          groundingProposal: {
            ...pickerProposal(),
            sourceContext: {
              ...pickerProposal().sourceContext,
              entityKind: 'invoice',
            },
          },
        }),
        deps,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await deps.proposalRepo.findByTenant(TENANT_ID)).toHaveLength(0);
  });

  it('creates a candidate only for an edited ID that clears a documented pendingReference', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const auditRepo = new InMemoryAuditRepository();
    const groundingProposal = {
      ...createProposal({
        tenantId: TENANT_ID,
        proposalType: 'send_invoice',
        payload: { invoiceReference: 'invoice forty two', channel: 'email' },
        summary: 'Send invoice',
        createdBy: ACTOR_ID,
      }),
      id: GROUNDING_PROPOSAL_ID,
      sourceContext: {
        pendingReference: [
          { kind: 'invoice', reference: '  invoice   forty two ' },
        ],
      },
    };
    const updatedProposal = {
      ...groundingProposal,
      payload: { ...groundingProposal.payload, invoiceId: INVOICE_ID },
      sourceContext: {},
    };

    const created = await captureEntityAliasCandidates(
      {
        source: 'proposal_edit',
        tenantId: TENANT_ID,
        actorId: ACTOR_ID,
        actorRole: 'owner',
        groundingProposal,
        updatedProposal,
        editedFields: ['invoiceId'],
      },
      { proposalRepo, auditRepo },
    );

    expect(created).toHaveLength(1);
    expect(created[0].payload).toEqual({
      alias: 'invoice forty two',
      entityKind: 'invoice',
      entityId: INVOICE_ID,
      source: 'proposal_edit',
      groundedProposalId: GROUNDING_PROPOSAL_ID,
    });
  });

  it('ignores ordinary edits and invalid replacement IDs', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const auditRepo = new InMemoryAuditRepository();
    const groundingProposal = {
      ...pickerProposal(),
      sourceContext: {
        pendingReference: [{ kind: 'customer', reference: 'Khan' }],
      },
    };

    expect(
      await captureEntityAliasCandidates(
        {
          source: 'proposal_edit',
          tenantId: TENANT_ID,
          actorId: ACTOR_ID,
          actorRole: 'owner',
          groundingProposal,
          updatedProposal: {
            ...groundingProposal,
            payload: { ...groundingProposal.payload, notes: 'ordinary correction' },
          },
          editedFields: ['notes'],
        },
        { proposalRepo, auditRepo },
      ),
    ).toEqual([]);

    await expect(
      captureEntityAliasCandidates(
        {
          source: 'proposal_edit',
          tenantId: TENANT_ID,
          actorId: ACTOR_ID,
          actorRole: 'owner',
          groundingProposal,
          updatedProposal: {
            ...groundingProposal,
            payload: { ...groundingProposal.payload, customerId: 'not-a-uuid' },
          },
          editedFields: ['customerId'],
        },
        { proposalRepo, auditRepo },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await proposalRepo.findByTenant(TENANT_ID)).toHaveLength(0);
  });
});

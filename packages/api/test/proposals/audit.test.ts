import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import {
  createProposal,
  InMemoryProposalRepository,
  CreateProposalInput,
} from '../../src/proposals/proposal';
import {
  logProposalEvent,
  getProposalTimeline,
  getEntityProposals,
  PROPOSAL_EVENT_TYPES,
} from '../../src/proposals/audit';

describe('P2-006 — Proposal audit timeline and entity linkage', () => {
  let auditRepo: InMemoryAuditRepository;
  let proposalRepo: InMemoryProposalRepository;

  const baseInput: CreateProposalInput = {
    tenantId: 'tenant-1',
    proposalType: 'create_customer',
    payload: { name: 'John Doe' },
    summary: 'Create customer from voice call',
    createdBy: 'user-1',
    targetEntityType: 'customer',
    targetEntityId: 'cust-1',
  };

  beforeEach(() => {
    auditRepo = new InMemoryAuditRepository();
    proposalRepo = new InMemoryProposalRepository();
  });

  it('registers the owner-driven retry of a failed execution', () => {
    expect(PROPOSAL_EVENT_TYPES).toContain('proposal.retried');
  });

  // The registry claims to be the inventory of proposal-lifecycle events: every
  // `proposal.*` literal the lifecycle actions and the onboarding draft writers
  // emit must be in it (proposal.undone shipped emitted but unlisted).
  it('lists every proposal.* event that proposals/actions.ts and onboarding/draft/*.ts emit', () => {
    const src = join(__dirname, '../../src');
    const draftDir = join(src, 'onboarding/draft');
    const files = [join(src, 'proposals/actions.ts'), ...readdirSync(draftDir).filter((f) => f.endsWith('.ts')).map((f) => join(draftDir, f))];
    const emitted = new Set<string>();
    for (const file of files) {
      for (const m of readFileSync(file, 'utf8').matchAll(/'(proposal\.[a-z_]+)'/g)) emitted.add(m[1]);
    }
    expect(emitted).toContain('proposal.undone');
    expect([...emitted].filter((e) => !(PROPOSAL_EVENT_TYPES as readonly string[]).includes(e))).toEqual([]);
  });

  it('happy path — logs proposal event and retrieves timeline', async () => {
    const proposal = createProposal(baseInput);
    await proposalRepo.create(proposal);

    const event = await logProposalEvent(
      auditRepo,
      proposal,
      'proposal.created',
      { id: 'user-1', role: 'owner' }
    );

    expect(event.id).toBeTruthy();
    expect(event.entityType).toBe('proposal');
    expect(event.entityId).toBe(proposal.id);
    expect(event.eventType).toBe('proposal.created');
    expect(event.actorId).toBe('user-1');
    expect(event.actorRole).toBe('owner');

    const timeline = await getProposalTimeline(auditRepo, 'tenant-1', proposal.id);
    expect(timeline).toHaveLength(1);
    expect(timeline[0].eventType).toBe('proposal.created');
  });

  it('happy path — finds proposals targeting an entity', async () => {
    const proposal1 = createProposal(baseInput);
    const proposal2 = createProposal({
      ...baseInput,
      summary: 'Update customer address',
      proposalType: 'update_customer',
      targetEntityType: 'customer',
      targetEntityId: 'cust-1',
    });
    const proposal3 = createProposal({
      ...baseInput,
      summary: 'Unrelated proposal',
      targetEntityType: 'job',
      targetEntityId: 'job-1',
    });

    await proposalRepo.create(proposal1);
    await proposalRepo.create(proposal2);
    await proposalRepo.create(proposal3);

    const results = await getEntityProposals(
      proposalRepo,
      'tenant-1',
      'customer',
      'cust-1'
    );
    expect(results).toHaveLength(2);
    expect(results.every((p) => p.targetEntityId === 'cust-1')).toBe(true);
  });

  it('validation — rejects audit event with missing actor', async () => {
    const proposal = createProposal(baseInput);

    await expect(
      logProposalEvent(auditRepo, proposal, 'proposal.created', {
        id: '',
        role: 'owner',
      })
    ).rejects.toThrow('actorId is required');
  });

  it('happy path — multiple events create chronological timeline', async () => {
    const proposal = createProposal(baseInput);
    await proposalRepo.create(proposal);

    await logProposalEvent(auditRepo, proposal, 'proposal.created', {
      id: 'user-1',
      role: 'owner',
    });

    await logProposalEvent(auditRepo, proposal, 'proposal.submitted', {
      id: 'user-1',
      role: 'owner',
    });

    await logProposalEvent(auditRepo, proposal, 'proposal.approved', {
      id: 'user-2',
      role: 'dispatcher',
    });

    const timeline = await getProposalTimeline(auditRepo, 'tenant-1', proposal.id);
    expect(timeline).toHaveLength(3);
    expect(timeline[0].eventType).toBe('proposal.created');
    expect(timeline[1].eventType).toBe('proposal.submitted');
    expect(timeline[2].eventType).toBe('proposal.approved');

    for (let i = 1; i < timeline.length; i++) {
      expect(timeline[i].createdAt.getTime()).toBeGreaterThanOrEqual(
        timeline[i - 1].createdAt.getTime()
      );
    }
  });
});

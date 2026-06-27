import {
  createProposal,
  validateProposalInput,
  InMemoryProposalRepository,
  CreateProposalInput,
  ProposalType,
  Proposal,
  decideInitialStatus,
  actionClassForProposalType,
} from '../../src/proposals/proposal';
import { ConflictError } from '../../src/shared/errors';

describe('P2-001 — Proposal entity and core schema', () => {
  const validInput: CreateProposalInput = {
    tenantId: 'tenant-1',
    proposalType: 'create_customer',
    payload: { name: 'John Doe', phone: '555-1234' },
    summary: 'Create new customer John Doe from voice call',
    explanation: 'Extracted customer details from transcript',
    confidenceScore: 0.92,
    confidenceFactors: ['name_clearly_stated', 'phone_confirmed'],
    sourceContext: { conversationId: 'conv-1' },
    aiRunId: 'ai-run-1',
    promptVersionId: 'pv-1',
    targetEntityType: 'customer',
    targetEntityId: 'cust-draft-1',
    idempotencyKey: 'idem-key-1',
    expiresAt: new Date('2026-12-31'),
    createdBy: 'user-1',
  };

  it('happy path — creates proposal with all fields', () => {
    const proposal = createProposal(validInput);

    expect(proposal.id).toBeTruthy();
    expect(proposal.tenantId).toBe('tenant-1');
    expect(proposal.proposalType).toBe('create_customer');
    expect(proposal.status).toBe('draft');
    expect(proposal.payload).toEqual({ name: 'John Doe', phone: '555-1234' });
    expect(proposal.summary).toBe('Create new customer John Doe from voice call');
    expect(proposal.explanation).toBe('Extracted customer details from transcript');
    expect(proposal.confidenceScore).toBe(0.92);
    expect(proposal.confidenceFactors).toEqual(['name_clearly_stated', 'phone_confirmed']);
    expect(proposal.sourceContext).toEqual({ conversationId: 'conv-1' });
    expect(proposal.aiRunId).toBe('ai-run-1');
    expect(proposal.promptVersionId).toBe('pv-1');
    expect(proposal.targetEntityType).toBe('customer');
    expect(proposal.targetEntityId).toBe('cust-draft-1');
    expect(proposal.idempotencyKey).toBe('idem-key-1');
    expect(proposal.expiresAt).toEqual(new Date('2026-12-31'));
    expect(proposal.createdBy).toBe('user-1');
    expect(proposal.createdAt).toBeInstanceOf(Date);
    expect(proposal.updatedAt).toBeInstanceOf(Date);
  });

  it('happy path — creates proposal with minimal fields', () => {
    const proposal = createProposal({
      tenantId: 'tenant-1',
      proposalType: 'draft_estimate',
      payload: { lineItems: [] },
      summary: 'Draft estimate for plumbing repair',
      createdBy: 'user-1',
    });

    expect(proposal.id).toBeTruthy();
    expect(proposal.status).toBe('draft');
    expect(proposal.proposalType).toBe('draft_estimate');
    expect(proposal.confidenceScore).toBeUndefined();
    expect(proposal.aiRunId).toBeUndefined();
    expect(proposal.explanation).toBeUndefined();
  });

  it('validation — rejects missing required fields', () => {
    const errors = validateProposalInput({
      tenantId: '',
      proposalType: '' as any,
      payload: null as any,
      summary: '',
      createdBy: '',
    });
    expect(errors).toContain('tenantId is required');
    expect(errors).toContain('proposalType is required');
    expect(errors).toContain('payload must be a non-null object');
    expect(errors).toContain('summary is required');
    expect(errors).toContain('createdBy is required');
  });

  it('validation — rejects invalid confidence score', () => {
    const tooHigh = validateProposalInput({ ...validInput, confidenceScore: 1.5 });
    expect(tooHigh).toContain('confidenceScore must be a number between 0 and 1');

    const tooLow = validateProposalInput({ ...validInput, confidenceScore: -0.1 });
    expect(tooLow).toContain('confidenceScore must be a number between 0 and 1');

    const notNumber = validateProposalInput({ ...validInput, confidenceScore: 'high' as any });
    expect(notNumber).toContain('confidenceScore must be a number between 0 and 1');
  });

  it('validation — rejects invalid proposal type', () => {
    const errors = validateProposalInput({
      ...validInput,
      proposalType: 'invalid_type' as any,
    });
    expect(errors).toContain('proposalType is invalid');
  });

  it('tenant isolation — cross-tenant data inaccessible', async () => {
    const repo = new InMemoryProposalRepository();
    const proposal = createProposal(validInput);
    await repo.create(proposal);

    const found = await repo.findById('other-tenant', proposal.id);
    expect(found).toBeNull();

    const byTenant = await repo.findByTenant('other-tenant');
    expect(byTenant).toHaveLength(0);

    const byStatus = await repo.findByStatus('other-tenant', 'draft');
    expect(byStatus).toHaveLength(0);

    const byAiRun = await repo.findByAiRun('other-tenant', 'ai-run-1');
    expect(byAiRun).toHaveLength(0);

    const updated = await repo.updateStatus('other-tenant', proposal.id, 'approved');
    expect(updated).toBeNull();

    const patched = await repo.update('other-tenant', proposal.id, { summary: 'hacked' });
    expect(patched).toBeNull();
  });

  it('findByStatusSince — windows by created_at, newest-first, honours limit (P3)', async () => {
    const repo = new InMemoryProposalRepository();
    const now = Date.now();
    const mk = (over: Partial<Proposal>): Proposal => ({
      ...createProposal({ ...validInput, idempotencyKey: undefined }),
      ...over,
    });
    await repo.create(mk({ id: 'p-recent', status: 'ready_for_review', createdAt: new Date(now - 10 * 60_000) }));
    await repo.create(mk({ id: 'p-2h', status: 'ready_for_review', createdAt: new Date(now - 2 * 3_600_000) }));
    await repo.create(mk({ id: 'p-48h', status: 'ready_for_review', createdAt: new Date(now - 48 * 3_600_000) }));
    await repo.create(mk({ id: 'p-draft', status: 'draft', createdAt: new Date(now - 10 * 60_000) }));

    const since = new Date(now - 24 * 3_600_000);
    const within = await repo.findByStatusSince('tenant-1', 'ready_for_review', since);
    // 48h row is outside the window; the draft is a different status. Newest first.
    expect(within.map((p) => p.id)).toEqual(['p-recent', 'p-2h']);

    const limited = await repo.findByStatusSince('tenant-1', 'ready_for_review', since, 1);
    expect(limited.map((p) => p.id)).toEqual(['p-recent']);

    // Tenant-scoped.
    expect(await repo.findByStatusSince('other-tenant', 'ready_for_review', since)).toHaveLength(0);
  });

  it('createMany persists every member and is atomic on idempotency conflict', async () => {
    const repo = new InMemoryProposalRepository();
    // Chain members carry no idempotency key (they dedupe by recordingId
    // at the worker layer), so use undefined here.
    const a = createProposal({ ...validInput, idempotencyKey: undefined, summary: 'chain-a' });
    const b = createProposal({ ...validInput, idempotencyKey: undefined, summary: 'chain-b' });
    const created = await repo.createMany([a, b]);
    expect(created).toHaveLength(2);
    expect(await repo.findByTenant(validInput.tenantId)).toHaveLength(2);

    // A batch with a duplicate idempotency key rejects without persisting
    // any member (validated before the commit loop).
    const repo2 = new InMemoryProposalRepository();
    const c = createProposal({ ...validInput, idempotencyKey: 'dup', summary: 'c' });
    const d = createProposal({ ...validInput, idempotencyKey: 'dup', summary: 'd' });
    await expect(repo2.createMany([c, d])).rejects.toThrow();
    expect(await repo2.findByTenant(validInput.tenantId)).toHaveLength(0);
  });

  it('idempotency — duplicate key within tenant throws ConflictError', async () => {
    const repo = new InMemoryProposalRepository();
    const proposal1 = createProposal(validInput);
    const proposal2 = createProposal({ ...validInput, summary: 'Different summary' });

    await repo.create(proposal1);
    await expect(repo.create(proposal2)).rejects.toThrow(ConflictError);

    const all = await repo.findByTenant('tenant-1');
    expect(all).toHaveLength(1);
  });

  it('mock provider test — repository stores and retrieves', async () => {
    const repo = new InMemoryProposalRepository();
    const proposal = createProposal(validInput);
    await repo.create(proposal);

    const found = await repo.findById('tenant-1', proposal.id);
    expect(found).not.toBeNull();
    expect(found!.proposalType).toBe('create_customer');
    expect(found!.summary).toBe('Create new customer John Doe from voice call');

    const byStatus = await repo.findByStatus('tenant-1', 'draft');
    expect(byStatus).toHaveLength(1);

    const byAiRun = await repo.findByAiRun('tenant-1', 'ai-run-1');
    expect(byAiRun).toHaveLength(1);

    const updated = await repo.updateStatus('tenant-1', proposal.id, 'approved', {
      executedBy: 'user-2',
      executedAt: new Date(),
    });
    expect(updated!.status).toBe('approved');
    expect(updated!.executedBy).toBe('user-2');

    const patched = await repo.update('tenant-1', proposal.id, { summary: 'Updated summary' });
    expect(patched!.summary).toBe('Updated summary');
    expect(patched!.updatedAt.getTime()).toBeGreaterThanOrEqual(proposal.updatedAt.getTime());
  });

  it('validation — duplicate idempotency key within tenant throws ConflictError', async () => {
    const repo = new InMemoryProposalRepository();
    const proposal1 = createProposal({ ...validInput, idempotencyKey: 'key-1' });
    await repo.create(proposal1);

    const proposal2 = createProposal({ ...validInput, idempotencyKey: 'key-1' });
    await expect(repo.create(proposal2)).rejects.toThrow(ConflictError);
  });

  it('validation — same idempotency key in different tenants is allowed', async () => {
    const repo = new InMemoryProposalRepository();
    const proposal1 = createProposal({ ...validInput, tenantId: 'tenant-1', idempotencyKey: 'key-1' });
    await repo.create(proposal1);

    const proposal2 = createProposal({ ...validInput, tenantId: 'tenant-2', idempotencyKey: 'key-1' });
    await expect(repo.create(proposal2)).resolves.toBeDefined();
  });

  it('validation — null idempotency keys do not conflict', async () => {
    const repo = new InMemoryProposalRepository();
    const { idempotencyKey: _1, ...inputWithoutKey } = validInput;
    const proposal1 = createProposal(inputWithoutKey as CreateProposalInput);
    await repo.create(proposal1);

    const proposal2 = createProposal(inputWithoutKey as CreateProposalInput);
    await expect(repo.create(proposal2)).resolves.toBeDefined();
  });

  it('malformed AI output handled gracefully — invalid payload shape', () => {
    const errors = validateProposalInput({
      tenantId: 'tenant-1',
      proposalType: 'create_customer',
      payload: null as any,
      summary: 'Test',
      createdBy: 'user-1',
    });
    expect(errors).toContain('payload must be a non-null object');

    const arrayPayloadErrors = validateProposalInput({
      tenantId: 'tenant-1',
      proposalType: 'create_customer',
      payload: 'not-an-object' as any,
      summary: 'Test',
      createdBy: 'user-1',
    });
    expect(arrayPayloadErrors).toContain('payload must be a non-null object');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Decision 3 — Action-class registry + decideInitialStatus
//
// The 2026-04-14 retrospective identified Decision 3 as the only decision
// with no runtime wiring on the TS side. Step 5b adds the action-class
// registry and a single pure decision function that maps
// (action class, trust tier, confidence) → initial proposal status.
// These tests lock the rules so they cannot silently regress.
// ════════════════════════════════════════════════════════════════════════════

describe('actionClassForProposalType — D3 action-class registry', () => {
  it('classifies create_customer as capture', () => {
    expect(actionClassForProposalType('create_customer')).toBe('capture');
  });

  it('classifies update_customer as capture', () => {
    expect(actionClassForProposalType('update_customer')).toBe('capture');
  });

  it('classifies create_job as capture', () => {
    expect(actionClassForProposalType('create_job')).toBe('capture');
  });

  it('classifies create_appointment as capture', () => {
    expect(actionClassForProposalType('create_appointment')).toBe('capture');
  });

  it('classifies draft_estimate as capture', () => {
    expect(actionClassForProposalType('draft_estimate')).toBe('capture');
  });

  it('classifies draft_invoice as capture (drafting moves no money)', () => {
    expect(actionClassForProposalType('draft_invoice')).toBe('capture');
  });

  it('classifies reschedule_appointment as capture', () => {
    expect(actionClassForProposalType('reschedule_appointment')).toBe('capture');
  });

  it('classifies cancel_appointment as irreversible (always asks)', () => {
    expect(actionClassForProposalType('cancel_appointment')).toBe('irreversible');
  });

  it('classifies all onboarding_* types as capture', () => {
    const onboardingTypes: ProposalType[] = [
      'onboarding_tenant_settings',
      'onboarding_service_category',
      'onboarding_estimate_template',
      'onboarding_team_member',
      'onboarding_schedule',
    ];
    for (const t of onboardingTypes) {
      expect(actionClassForProposalType(t)).toBe('capture');
    }
  });

  it('classifies send_payment_reminder as comms (customer-facing dunning)', () => {
    expect(actionClassForProposalType('send_payment_reminder')).toBe('comms');
  });

  it('classifies apply_late_fee as money (raises amount due)', () => {
    expect(actionClassForProposalType('apply_late_fee')).toBe('money');
  });
});

describe('decideInitialStatus — D3 trust-tier decision', () => {
  it('no source trust tier → draft (existing behavior preserved)', () => {
    expect(
      decideInitialStatus({
        proposalType: 'create_customer',
        confidenceScore: 0.99,
      })
    ).toBe('draft');
  });

  it('autonomous + capture + confidence ≥ 0.9 → approved', () => {
    expect(
      decideInitialStatus({
        proposalType: 'create_customer',
        sourceTrustTier: 'autonomous',
        confidenceScore: 0.95,
      })
    ).toBe('approved');
  });

  it('autonomous + capture + confidence at exact 0.9 → approved', () => {
    // The threshold is inclusive — 0.9 is enough.
    expect(
      decideInitialStatus({
        proposalType: 'create_customer',
        sourceTrustTier: 'autonomous',
        confidenceScore: 0.9,
      })
    ).toBe('approved');
  });

  it('autonomous + capture + confidence < 0.9 → draft', () => {
    expect(
      decideInitialStatus({
        proposalType: 'create_customer',
        sourceTrustTier: 'autonomous',
        confidenceScore: 0.89,
      })
    ).toBe('draft');
  });

  it('autonomous + capture + missing confidence → draft (no signal)', () => {
    expect(
      decideInitialStatus({
        proposalType: 'create_customer',
        sourceTrustTier: 'autonomous',
      })
    ).toBe('draft');
  });

  it('autonomous + irreversible (cancel) at high confidence → draft (always_asks)', () => {
    // Even with autonomous tier and 0.99 confidence, cancel_appointment
    // is irreversible → never auto-approve.
    expect(
      decideInitialStatus({
        proposalType: 'cancel_appointment',
        sourceTrustTier: 'autonomous',
        confidenceScore: 0.99,
      })
    ).toBe('draft');
  });

  it('autonomous + send_payment_reminder (comms) at high confidence → draft (never auto-approves)', () => {
    // Dunning reminders are customer-facing comms — the owner must approve
    // before a customer is contacted, even at maximum trust + confidence.
    expect(
      decideInitialStatus({
        proposalType: 'send_payment_reminder',
        sourceTrustTier: 'autonomous',
        confidenceScore: 0.99,
      })
    ).toBe('draft');
  });

  it('autonomous + apply_late_fee (money) at high confidence → draft (never auto-applies money)', () => {
    // Applying a late fee moves money — hard-blocked from auto-approval
    // regardless of trust tier or confidence.
    expect(
      decideInitialStatus({
        proposalType: 'apply_late_fee',
        sourceTrustTier: 'autonomous',
        confidenceScore: 0.99,
      })
    ).toBe('draft');
  });

  it('graduates_fast + capture + high confidence → draft (gated until trust ledger lands)', () => {
    expect(
      decideInitialStatus({
        proposalType: 'create_customer',
        sourceTrustTier: 'graduates_fast',
        confidenceScore: 0.99,
      })
    ).toBe('draft');
  });

  it('graduates_slowly + capture + high confidence → draft (gated)', () => {
    expect(
      decideInitialStatus({
        proposalType: 'draft_estimate',
        sourceTrustTier: 'graduates_slowly',
        confidenceScore: 0.99,
      })
    ).toBe('draft');
  });

  it('always_asks + capture + high confidence → draft (forever gated)', () => {
    expect(
      decideInitialStatus({
        proposalType: 'create_customer',
        sourceTrustTier: 'always_asks',
        confidenceScore: 0.99,
      })
    ).toBe('draft');
  });

  // missingFields override — partial payloads can never auto-execute.
  // The forcing function: even a maximally-trusted autonomous agent
  // at 0.95 confidence on a capture-class proposal stays in 'draft'
  // whenever the task handler reports a gap. Review UI blocks
  // Approve until the operator fills the listed fields.
  it('missingFields non-empty forces draft even with autonomous + capture + 0.95', () => {
    expect(
      decideInitialStatus({
        proposalType: 'create_customer',
        sourceTrustTier: 'autonomous',
        confidenceScore: 0.95,
        missingFields: ['email'],
      })
    ).toBe('draft');
  });

  it('missingFields empty array behaves as no-missingFields (preserves auto-approve path)', () => {
    // An empty array should NOT be treated as "gaps exist" — it's
    // semantically "we checked, nothing missing".
    expect(
      decideInitialStatus({
        proposalType: 'create_customer',
        sourceTrustTier: 'autonomous',
        confidenceScore: 0.95,
        missingFields: [],
      })
    ).toBe('approved');
  });
});

describe('createProposal — D3 trust-tier integration', () => {
  it('without sourceTrustTier, status is draft (backward compatible)', () => {
    const proposal = createProposal({
      tenantId: 'tenant-1',
      proposalType: 'create_customer',
      payload: { name: 'Acme' },
      summary: 'Create customer Acme',
      confidenceScore: 0.99,
      createdBy: 'user-1',
    });
    expect(proposal.status).toBe('draft');
  });

  it('with sourceTrustTier=autonomous + capture + 0.95 confidence, status is approved', () => {
    const proposal = createProposal({
      tenantId: 'tenant-1',
      proposalType: 'create_customer',
      payload: { name: 'Acme' },
      summary: 'Create customer Acme via CaptureAgent',
      sourceTrustTier: 'autonomous',
      confidenceScore: 0.95,
      createdBy: 'agent-capture',
    });
    expect(proposal.status).toBe('approved');
  });

  it('forwards supervisorPresent=false: autonomous + capture + 0.95 → ready_for_review, not approved', () => {
    // Regression for the P0 launch blocker: createProposal used to DROP
    // supervisorPresent before calling decideInitialStatus, so the
    // unsupervised hard-block never engaged and a high-confidence voice
    // booking auto-approved (→ auto-executed) with no human in the loop.
    const proposal = createProposal({
      tenantId: 'tenant-1',
      proposalType: 'create_appointment',
      payload: { jobId: 'job-1' },
      summary: 'Book via voice',
      sourceTrustTier: 'autonomous',
      confidenceScore: 0.95,
      supervisorPresent: false,
      createdBy: 'agent-voice',
    });
    expect(proposal.status).toBe('ready_for_review');
    expect(proposal.approvedAt).toBeUndefined();
  });

  it('forwards supervisorPresent=true: autonomous + capture + 0.95 → approved (supervised path intact)', () => {
    const proposal = createProposal({
      tenantId: 'tenant-1',
      proposalType: 'create_appointment',
      payload: { jobId: 'job-1' },
      summary: 'Book via voice',
      sourceTrustTier: 'autonomous',
      confidenceScore: 0.95,
      supervisorPresent: true,
      createdBy: 'agent-voice',
    });
    expect(proposal.status).toBe('approved');
  });

  it('forwards tenantThresholdOverride: a stricter override blocks an otherwise-approved booking', () => {
    // The override was also silently dropped. With supervisor present + mode,
    // a 0.99 tenant threshold must hold a 0.95-confidence booking in draft.
    const proposal = createProposal({
      tenantId: 'tenant-1',
      proposalType: 'create_appointment',
      payload: { jobId: 'job-1' },
      summary: 'Book via voice',
      sourceTrustTier: 'autonomous',
      confidenceScore: 0.95,
      supervisorPresent: true,
      supervisorMode: 'supervisor',
      tenantThresholdOverride: { supervisor: 0.99 },
      createdBy: 'agent-voice',
    });
    expect(proposal.status).toBe('draft');
  });

  it('with sourceTrustTier=autonomous + cancel_appointment, status is draft (irreversible)', () => {
    const proposal = createProposal({
      tenantId: 'tenant-1',
      proposalType: 'cancel_appointment',
      payload: { appointmentId: 'appt-1' },
      summary: 'Cancel appt-1',
      sourceTrustTier: 'autonomous',
      confidenceScore: 0.99,
      createdBy: 'agent-capture',
    });
    expect(proposal.status).toBe('draft');
  });

  it('with sourceTrustTier=graduates_slowly + draft_estimate, status is draft (money class gated)', () => {
    const proposal = createProposal({
      tenantId: 'tenant-1',
      proposalType: 'draft_estimate',
      payload: { lineItems: [] },
      summary: 'Draft estimate via InvoiceAgent',
      sourceTrustTier: 'graduates_slowly',
      confidenceScore: 0.99,
      createdBy: 'agent-invoice',
    });
    expect(proposal.status).toBe('draft');
  });

  it('missingFields land in sourceContext and force draft even on autonomous + 0.95', () => {
    const proposal = createProposal({
      tenantId: 'tenant-1',
      proposalType: 'create_customer',
      payload: { name: 'Acme' },
      summary: 'Create customer Acme',
      sourceTrustTier: 'autonomous',
      confidenceScore: 0.95,
      createdBy: 'agent-capture',
      missingFields: ['email', 'phone'],
    });
    expect(proposal.status).toBe('draft');
    // missingFields ride on sourceContext so we don't need a new DB
    // column — the typed accessor `missingFieldsFor(proposal)` reads
    // them back.
    expect(proposal.sourceContext).toBeDefined();
    expect(proposal.sourceContext?.missingFields).toEqual(['email', 'phone']);
  });

  it('missingFields merge into existing sourceContext without clobbering other keys', () => {
    const proposal = createProposal({
      tenantId: 'tenant-1',
      proposalType: 'reschedule_appointment',
      payload: { appointmentReference: 'the Miller job' },
      summary: 'Reschedule',
      sourceContext: { conversationId: 'conv-42' },
      createdBy: 'user-1',
      missingFields: ['newScheduledStart'],
    });
    expect(proposal.sourceContext?.conversationId).toBe('conv-42');
    expect(proposal.sourceContext?.missingFields).toEqual(['newScheduledStart']);
  });
});

describe('InMemoryProposalRepository.findByRecordingId — voice dedup lookup', () => {
  const TENANT = 'tenant-rec';

  function seed(repo: InMemoryProposalRepository, p: Partial<Proposal> & { id: string }) {
    const now = new Date();
    return repo.create({
      tenantId: TENANT,
      proposalType: 'create_appointment',
      status: 'draft',
      payload: {},
      summary: 's',
      createdBy: 'u',
      createdAt: now,
      updatedAt: now,
      ...p,
    } as Proposal);
  }

  it('matches the single-action idempotency key', async () => {
    const repo = new InMemoryProposalRepository();
    await seed(repo, { id: 'p1', idempotencyKey: 'voice:rec-1' });
    const found = await repo.findByRecordingId(TENANT, 'rec-1', 'voice:rec-1');
    expect(found?.id).toBe('p1');
  });

  it('matches a chain member by sourceContext.recordingId (no shared key)', async () => {
    const repo = new InMemoryProposalRepository();
    await seed(repo, { id: 'p2', sourceContext: { recordingId: 'rec-2' } });
    const found = await repo.findByRecordingId(TENANT, 'rec-2', 'voice:rec-2');
    expect(found?.id).toBe('p2');
  });

  it('returns null when neither the key nor the recordingId matches', async () => {
    const repo = new InMemoryProposalRepository();
    await seed(repo, { id: 'p3', idempotencyKey: 'voice:other' });
    expect(await repo.findByRecordingId(TENANT, 'rec-x', 'voice:rec-x')).toBeNull();
  });

  it('is tenant-scoped — does not match another tenant', async () => {
    const repo = new InMemoryProposalRepository();
    await seed(repo, { id: 'p4', tenantId: 'other-tenant', idempotencyKey: 'voice:rec-4' } as Partial<Proposal> & { id: string });
    expect(await repo.findByRecordingId(TENANT, 'rec-4', 'voice:rec-4')).toBeNull();
  });
});

describe('§5.5 — schedule proposals carry a 48h expiry at creation', () => {
  const FORTY_EIGHT_H_MS = 48 * 60 * 60 * 1000;

  it.each(['create_appointment', 'create_booking', 'reschedule_appointment'] as const)(
    'defaults expiresAt to ~48h for %s',
    (proposalType) => {
      const before = Date.now();
      const p = createProposal({
        tenantId: 'tenant-1',
        proposalType,
        payload: {},
        summary: 's',
        createdBy: 'u1',
      });
      expect(p.expiresAt).toBeInstanceOf(Date);
      const delta = p.expiresAt!.getTime() - before;
      // generous window to absorb test-clock jitter
      expect(delta).toBeGreaterThanOrEqual(FORTY_EIGHT_H_MS - 5000);
      expect(delta).toBeLessThanOrEqual(FORTY_EIGHT_H_MS + 5000);
    },
  );

  it('leaves expiresAt unset for non-schedule proposal types (they persist)', () => {
    for (const proposalType of ['draft_estimate', 'send_invoice', 'create_customer', 'record_payment'] as const) {
      const p = createProposal({
        tenantId: 'tenant-1',
        proposalType,
        payload: {},
        summary: 's',
        createdBy: 'u1',
      });
      expect(p.expiresAt, `${proposalType} should persist`).toBeUndefined();
    }
  });

  it('honors an explicit expiresAt over the 48h default', () => {
    const explicit = new Date('2030-01-01T00:00:00Z');
    const p = createProposal({
      tenantId: 'tenant-1',
      proposalType: 'create_appointment',
      payload: {},
      summary: 's',
      createdBy: 'u1',
      expiresAt: explicit,
    });
    expect(p.expiresAt).toEqual(explicit);
  });
});

describe('§5.5 — InMemoryProposalRepository.findExpiredScheduleProposals', () => {
  const NOW = Date.now();
  const types = ['create_appointment', 'create_booking', 'reschedule_appointment'] as const;

  async function seedExpired(repo: InMemoryProposalRepository, opts: { type: ProposalType; ageMs: number; tenantId?: string }) {
    const p = createProposal({
      tenantId: opts.tenantId ?? 'tenant-1',
      proposalType: opts.type,
      payload: {},
      summary: `${opts.type}@${opts.ageMs}`,
      createdBy: 'u1',
      expiresAt: new Date(NOW - opts.ageMs),
    });
    await repo.create({ ...p, status: 'expired' });
    return p;
  }

  it('returns only schedule, in-window, this-tenant expired rows, newest-first and capped', async () => {
    const repo = new InMemoryProposalRepository();
    const since = new Date(NOW - 7 * 24 * 60 * 60 * 1000);
    await seedExpired(repo, { type: 'create_appointment', ageMs: 60 * 60 * 1000 }); // 1h ago (recent)
    await seedExpired(repo, { type: 'create_booking', ageMs: 2 * 60 * 60 * 1000 }); // 2h ago
    await seedExpired(repo, { type: 'reschedule_appointment', ageMs: 8 * 24 * 60 * 60 * 1000 }); // 8d ago (out of window)
    await seedExpired(repo, { type: 'create_appointment', ageMs: 30 * 60 * 1000, tenantId: 'other' }); // other tenant

    const rows = await repo.findExpiredScheduleProposals('tenant-1', types, since, 10);
    expect(rows.map((r) => r.summary)).toEqual([
      'create_appointment@3600000', // 1h ago first (newest expiresAt)
      'create_booking@7200000',     // 2h ago second
    ]);

    // limit is honored
    const capped = await repo.findExpiredScheduleProposals('tenant-1', types, since, 1);
    expect(capped).toHaveLength(1);
    expect(capped[0].summary).toBe('create_appointment@3600000');
  });
});

/**
 * B1 — an SMS reply approves as the role the sender actually holds.
 *
 * The reply transport recognised the backup supervisor's mobile as an
 * approver and then called every action with 'owner' (approve / APPROVE ALL /
 * reject / EDIT). A dispatcher backup could therefore approve config-writing
 * cards behind settings:update, and their texted price edits were stamped
 * executedByRole 'owner' — so the correction lessons cascaded into the labor
 * rate and the price book, authority the dashboard withholds from them
 * (PI-3). A technician backup cleared proposals:approve, which the role does
 * not hold at all.
 *
 * Now: the owner phone is still the owner (synthetic 'sms_reply' actor); the
 * backup acts as their DB role under their own subject; a role without
 * proposals:approve gets a plain refusal and nothing changes.
 */
import { describe, it, expect } from 'vitest';
import {
  handleProposalSmsReply,
  handleProposalSmsFallback,
  SMS_REPLY_ACTOR_ID,
  type ProposalSmsReplyDeps,
} from '../../../src/proposals/sms/reply-handler';
import {
  InMemoryProposalSmsEventRepository,
  createProposalSmsEvent,
} from '../../../src/proposals/sms/sms-event';
import { InMemoryProposalRepository, createProposal, type Proposal } from '../../../src/proposals/proposal';
import { InMemoryProposalExecutionRepository } from '../../../src/proposals/proposal-execution';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { InMemoryCatalogItemRepository, type CatalogItem } from '../../../src/catalog/catalog-item';
import { InMemoryCorrectionLessonRepository } from '../../../src/learning/corrections/correction-lesson';
import { FakeConfigPorts } from '../../../src/learning/corrections/lesson-applicator';
import { recordCorrectionLessonsOnExecution } from '../../../src/learning/corrections/record-on-execution';
import type { SettingsRepository } from '../../../src/settings/settings';
import type { User, UserRepository } from '../../../src/users/user';
import type { Role } from '../../../src/auth/rbac';
import type { InboundSmsContext } from '../../../src/sms/inbound-dispatch';

const TENANT = 't-b1-sms';
const OWNER_PHONE = '+15125550100';
const BACKUP_PHONE = '+15125550111';
const BACKUP_ID = 'user-backup-b1';
const BACKUP_SUBJECT = 'clerk-backup-b1';
const CUSTOMER = '9d3a7b1e-1111-4111-8111-111111111111';
const CAPACITOR = '9d3a7b1e-2222-4222-8222-222222222222';
const LABOR_RATE = 11500;
const CAPACITOR_PRICE = 4500;

function labor(cents: number) {
  return { id: 'l1', description: 'Labor', category: 'labor', quantity: 1, unitPrice: cents };
}
function capacitor(cents: number) {
  return {
    id: 'p1',
    description: 'Run capacitor',
    category: 'material',
    quantity: 1,
    unitPrice: cents,
    catalogItemId: CAPACITOR,
    pricingSource: 'catalog',
  };
}

interface Harness {
  deps: ProposalSmsReplyDeps;
  proposalRepo: InMemoryProposalRepository;
  auditRepo: InMemoryAuditRepository;
  sent: { to: string; body: string }[];
  settingsRepo: SettingsRepository;
}

function makeHarness(backupRole: Role | string, overrides: Partial<ProposalSmsReplyDeps> = {}): Harness {
  const proposalRepo = new InMemoryProposalRepository();
  const auditRepo = new InMemoryAuditRepository();
  const sent: { to: string; body: string }[] = [];
  const settingsRepo = {
    findByTenant: async () => ({
      tenantId: TENANT,
      ownerPhone: OWNER_PHONE,
      backupSupervisorUserId: BACKUP_ID,
      timezone: 'America/New_York',
      laborRateCentsPerHour: LABOR_RATE,
      brandVoice: { banned_phrases: [] },
    }),
  } as unknown as SettingsRepository;
  const backup = {
    id: BACKUP_ID,
    tenantId: TENANT,
    role: backupRole,
    clerkUserId: BACKUP_SUBJECT,
    mobileNumber: BACKUP_PHONE,
    status: 'active',
  } as unknown as User;
  const userRepo = {
    findById: async (t: string, id: string) => (t === TENANT && id === BACKUP_ID ? backup : null),
  } as unknown as UserRepository;
  const deps: ProposalSmsReplyDeps = {
    proposalRepo,
    smsEventRepo: new InMemoryProposalSmsEventRepository(),
    settingsRepo,
    userRepo,
    auditRepo,
    sendSms: async (to, body) => {
      sent.push({ to, body });
    },
    ...overrides,
  };
  return { deps, proposalRepo, auditRepo, sent, settingsRepo };
}

async function seedRendered(h: Harness, input: Parameters<typeof createProposal>[0]): Promise<Proposal> {
  const proposal = await h.proposalRepo.create({ ...createProposal(input), status: 'ready_for_review' });
  await h.deps.smsEventRepo.create(
    createProposalSmsEvent({
      tenantId: TENANT,
      proposalId: proposal.id,
      direction: 'outbound',
      kind: 'proposal_rendered',
      body: `${proposal.summary}. Reply Y to approve, N to reject, EDIT to change.`,
    }),
  );
  return proposal;
}

const seedEstimate = (h: Harness) =>
  seedRendered(h, {
    tenantId: TENANT,
    proposalType: 'draft_estimate',
    payload: { customerId: CUSTOMER, lineItems: [labor(LABOR_RATE), capacitor(CAPACITOR_PRICE)] },
    summary: 'Estimate for the Garcia condenser',
    confidenceScore: 0.95,
    createdBy: 'voice',
  });

function ctx(body: string, fromE164: string): InboundSmsContext {
  return { tenantId: TENANT, fromE164, body, messageSid: `SM-${Math.random().toString(36).slice(2)}` };
}

/** "EDIT labor $200/hr and the capacitor $60", interpreted as a payload delta. */
const priceEdit: ProposalSmsReplyDeps['interpretEdit'] = async () => ({
  delta: { lineItems: [labor(20000), capacitor(6000)] },
});

/** Execute (succeeded, at the approved payload) and run the lesson recorder. */
async function executeAndRecordLessons(h: Harness, proposalId: string) {
  const executed = (await h.proposalRepo.findById(TENANT, proposalId))!;
  const proposalExecutionRepo = new InMemoryProposalExecutionRepository();
  await proposalExecutionRepo.recordExecution({
    tenantId: TENANT,
    proposalId,
    executedPayload: executed.payload,
    executedBy: 'execution-worker',
    status: 'succeeded',
  });
  const catalogRepo = new InMemoryCatalogItemRepository();
  await catalogRepo.create({
    id: CAPACITOR,
    tenantId: TENANT,
    name: 'Run capacitor',
    description: '',
    category: 'Materials',
    unit: 'each',
    productServiceType: 'product',
    unitPriceCents: CAPACITOR_PRICE,
    archivedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as CatalogItem);
  const ports = new FakeConfigPorts({ laborRateCents: LABOR_RATE, skuPriceCents: { [CAPACITOR]: CAPACITOR_PRICE } });
  const lessonRepo = new InMemoryCorrectionLessonRepository();
  const lessons = await recordCorrectionLessonsOnExecution(
    { tenantId: TENANT, proposalId },
    {
      proposalRepo: h.proposalRepo,
      proposalExecutionRepo,
      settingsRepo: h.settingsRepo,
      lessonRepo,
      catalogRepo,
      ports,
      auditRepo: h.auditRepo,
    },
  );
  return { lessons, ports, catalogRepo };
}

describe('B1 — a backup dispatcher’s EDIT then Y teaches the price book nothing', () => {
  it('approves as the dispatcher, and the executed edit records ZERO correction lessons', async () => {
    const h = makeHarness('dispatcher', { interpretEdit: priceEdit });
    const proposal = await seedEstimate(h);

    const edit = await handleProposalSmsReply(ctx('EDIT labor $200/hr and the capacitor $60', BACKUP_PHONE), h.deps);
    expect(edit).toMatchObject({ handled: true, reason: 'edited' });
    const approve = await handleProposalSmsReply(ctx('Y', BACKUP_PHONE), h.deps);
    expect(approve).toMatchObject({ handled: true, reason: 'approved' });

    const approved = (await h.proposalRepo.findById(TENANT, proposal.id))!;
    expect(approved.status).toBe('approved');
    expect(approved.executedByRole).toBe('dispatcher');
    expect(approved.executedBy).toBe(BACKUP_SUBJECT);
    const audits = h.auditRepo.getAll();
    expect(audits.find((e) => e.eventType === 'proposal.edited')).toMatchObject({
      actorId: BACKUP_SUBJECT,
      actorRole: 'dispatcher',
    });
    expect(audits.find((e) => e.eventType === 'proposal.approved')).toMatchObject({
      actorId: BACKUP_SUBJECT,
      actorRole: 'dispatcher',
    });

    const { lessons, ports, catalogRepo } = await executeAndRecordLessons(h, proposal.id);
    expect(lessons).toEqual([]);
    expect(ports.laborRateCents).toBe(LABOR_RATE);
    expect(ports.skuPriceCents[CAPACITOR]).toBe(CAPACITOR_PRICE);
    expect((await catalogRepo.findById(TENANT, CAPACITOR))?.unitPriceCents).toBe(CAPACITOR_PRICE);
  });

  it('the owner phone is unchanged: the same EDIT then Y approves as owner and the lessons cascade', async () => {
    const h = makeHarness('dispatcher', { interpretEdit: priceEdit });
    const proposal = await seedEstimate(h);

    await handleProposalSmsReply(ctx('EDIT labor $200/hr and the capacitor $60', OWNER_PHONE), h.deps);
    await handleProposalSmsReply(ctx('Y', OWNER_PHONE), h.deps);

    const approved = (await h.proposalRepo.findById(TENANT, proposal.id))!;
    expect(approved.executedByRole).toBe('owner');
    expect(approved.executedBy).toBe(SMS_REPLY_ACTOR_ID);
    const { lessons, ports } = await executeAndRecordLessons(h, proposal.id);
    expect(lessons.length).toBeGreaterThan(0);
    expect(ports.laborRateCents).toBe(20000);
    expect(ports.skuPriceCents[CAPACITOR]).toBe(6000);
  });

  it('APPROVE ALL from the backup approves as the dispatcher too', async () => {
    const h = makeHarness('dispatcher');
    const proposal = await seedEstimate(h);

    const result = await handleProposalSmsReply(ctx('APPROVE ALL', BACKUP_PHONE), h.deps);

    expect(result).toMatchObject({ handled: true, reason: 'approved_all' });
    const approved = (await h.proposalRepo.findById(TENANT, proposal.id))!;
    expect(approved.status).toBe('approved');
    expect(approved.executedByRole).toBe('dispatcher');
    expect(approved.executedBy).toBe(BACKUP_SUBJECT);
  });

  it('N from the backup rejects under their own identity', async () => {
    const h = makeHarness('dispatcher');
    const proposal = await seedEstimate(h);

    const result = await handleProposalSmsReply(ctx('N wrong customer', BACKUP_PHONE), h.deps);

    expect(result).toMatchObject({ handled: true, reason: 'rejected' });
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe('rejected');
    expect(h.auditRepo.getAll().find((e) => e.eventType === 'proposal.rejected')).toMatchObject({
      actorId: BACKUP_SUBJECT,
      actorRole: 'dispatcher',
    });
  });
});

describe('B1 — a backup dispatcher cannot approve a card that needs settings:update', () => {
  const seedCatalogPriceChange = (h: Harness) =>
    seedRendered(h, {
      tenantId: TENANT,
      proposalType: 'update_catalog_item',
      payload: { catalogItemId: CAPACITOR, unitPriceCents: 9900 },
      summary: 'Raise the run capacitor to $99',
      confidenceScore: 0.95,
      createdBy: 'voice',
    });

  it('Y gets the approve-failed reply in plain words, and nothing is approved', async () => {
    const h = makeHarness('dispatcher');
    const proposal = await seedCatalogPriceChange(h);

    const result = await handleProposalSmsReply(ctx('Y', BACKUP_PHONE), h.deps);

    expect(result).toMatchObject({ handled: true, reason: 'approve_failed' });
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe('ready_for_review');
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].to).toBe(BACKUP_PHONE);
    expect(h.sent[0].body).toMatch(/owner/i);
    expect(h.sent[0].body).not.toMatch(/proposal|dashboard|AI\b|agent|verify/i);
    expect(h.auditRepo.getAll().map((e) => e.eventType)).not.toContain('proposal.approved');
  });

  it('the owner phone still approves it', async () => {
    const h = makeHarness('dispatcher');
    const proposal = await seedCatalogPriceChange(h);

    const result = await handleProposalSmsReply(ctx('Y', OWNER_PHONE), h.deps);

    expect(result).toMatchObject({ handled: true, reason: 'approved' });
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe('approved');
  });
});

describe('B1 — a backup whose role cannot approve is refused outright', () => {
  it.each(['Y', 'APPROVE ALL', 'N', 'EDIT make it $200'])(
    'a technician backup texting %s changes nothing and is told plainly',
    async (body) => {
      const h = makeHarness('technician', { interpretEdit: priceEdit });
      const proposal = await seedEstimate(h);

      const result = await handleProposalSmsReply(ctx(body, BACKUP_PHONE), h.deps);

      expect(result).toMatchObject({ handled: true, reason: 'approve_failed' });
      const after = (await h.proposalRepo.findById(TENANT, proposal.id))!;
      expect(after.status).toBe('ready_for_review');
      expect(after.payload).toEqual(proposal.payload);
      expect(h.sent).toHaveLength(1);
      // B4 follow-up — one reply for Y, ALL, N and EDIT, so it names all three.
      expect(h.sent[0].body).toBe(
        'You can’t approve, reject or change work by text, so nothing changed. Ask the owner to handle it.',
      );
      expect(h.sent[0].body).not.toMatch(/proposal|dashboard|AI\b|agent|verify/i);
      const types = h.auditRepo.getAll().map((e) => e.eventType);
      expect(types).toContain('proposal.sms_reply_role_cannot_approve');
      expect(types).not.toContain('proposal.approved');
      expect(types).not.toContain('proposal.rejected');
      expect(types).not.toContain('proposal.edited');
    },
  );

  it('free text from a technician backup is not captured as an edit or nudged', async () => {
    const h = makeHarness('technician');
    await seedEstimate(h);

    const result = await handleProposalSmsFallback(ctx('can we do it cheaper', BACKUP_PHONE), h.deps);

    expect(result).toMatchObject({ handled: false, reason: 'not_owner' });
    expect(h.sent).toHaveLength(0);
  });

  it('a backup whose stored role is unknown is not an approver at all (fail closed)', async () => {
    const h = makeHarness('superuser');
    const proposal = await seedEstimate(h);

    const result = await handleProposalSmsReply(ctx('Y', BACKUP_PHONE), h.deps);

    expect(result).toMatchObject({ handled: false, reason: 'unknown_mobile' });
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe('ready_for_review');
  });
});

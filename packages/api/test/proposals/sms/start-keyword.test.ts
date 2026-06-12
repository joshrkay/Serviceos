/**
 * P2-034 / TCPA — the YES keyword collision (PR #528 review P1).
 *
 * YES is both the compliance re-opt-in keyword and the owner's most
 * natural approve reply. These tests pin the composite's contract:
 * opt-in always wins (a DNC-listed sender's YES removes them and never
 * approves anything — even the owner's), and only a non-DNC owner's YES
 * reaches proposal approval. Registration-level tests prove the proposal
 * handler no longer claims any compliance-reserved keyword directly.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildStartOrApproveKeywordHandler } from '../../../src/proposals/sms/start-keyword';
import {
  ProposalReplyKeywordHandler,
  COMPLIANCE_RESERVED_TOKENS,
  type ProposalSmsReplyDeps,
} from '../../../src/proposals/sms/reply-handler';
import { registerProposalReplySms } from '../../../src/proposals/sms';
import {
  InMemoryProposalSmsEventRepository,
  createProposalSmsEvent,
} from '../../../src/proposals/sms/sms-event';
import {
  InMemoryProposalRepository,
  createProposal,
  type Proposal,
} from '../../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { InMemoryDncRepository, normalizePhone } from '../../../src/compliance/dnc';
import { START_KEYWORDS, STOP_KEYWORDS } from '../../../src/compliance/stop-reply';
import {
  dispatchInboundSms,
  __resetKeywordRegistryForTests,
  type InboundSmsContext,
} from '../../../src/sms/inbound-dispatch';
import type { SettingsRepository } from '../../../src/settings/settings';

const TENANT = 't-1';
const OWNER_PHONE = '+15125550100';
const CUSTOMER_PHONE = '+15125559999';

interface Harness {
  deps: ProposalSmsReplyDeps;
  proposalRepo: InMemoryProposalRepository;
  dncRepo: InMemoryDncRepository;
  sent: { to: string; body: string }[];
}

function makeHarness(): Harness {
  const proposalRepo = new InMemoryProposalRepository();
  const smsEventRepo = new InMemoryProposalSmsEventRepository();
  const sent: { to: string; body: string }[] = [];
  return {
    proposalRepo,
    dncRepo: new InMemoryDncRepository(),
    sent,
    deps: {
      proposalRepo,
      smsEventRepo,
      settingsRepo: {
        findByTenant: async () => ({ ownerPhone: OWNER_PHONE }),
      } as unknown as SettingsRepository,
      auditRepo: new InMemoryAuditRepository(),
      sendSms: async (to, body) => {
        sent.push({ to, body });
      },
    },
  };
}

async function seedPendingProposal(h: Harness): Promise<Proposal> {
  const base = createProposal({
    tenantId: TENANT,
    proposalType: 'add_note',
    payload: { message: 'note' },
    summary: 'Add a note to the Lee job',
    createdBy: 'voice',
  });
  const proposal = await h.proposalRepo.create({ ...base, status: 'ready_for_review' });
  await h.deps.smsEventRepo.create(
    createProposalSmsEvent({
      tenantId: TENANT,
      proposalId: proposal.id,
      direction: 'outbound',
      kind: 'proposal_rendered',
      body: 'Add a note. Reply Y to approve.',
    }),
  );
  return proposal;
}

function ctx(body: string, fromE164: string): InboundSmsContext {
  return {
    tenantId: TENANT,
    fromE164,
    body,
    messageSid: `SM-${Math.random().toString(36).slice(2)}`,
  };
}

describe('keyword ownership', () => {
  it('the proposal handler never registers a compliance-reserved keyword', () => {
    const h = makeHarness();
    const handler = new ProposalReplyKeywordHandler(h.deps);
    for (const keyword of handler.keywords) {
      expect(COMPLIANCE_RESERVED_TOKENS.has(keyword)).toBe(false);
    }
    // The collision this guards against: YES is a START keyword.
    expect(handler.keywords).not.toContain('yes');
    for (const reserved of [...START_KEYWORDS, ...STOP_KEYWORDS]) {
      expect(COMPLIANCE_RESERVED_TOKENS.has(reserved.toLowerCase())).toBe(true);
    }
  });
});

describe('buildStartOrApproveKeywordHandler', () => {
  it('YES from a DNC-listed customer is an opt-in — removed, nothing approved', async () => {
    const h = makeHarness();
    const proposal = await seedPendingProposal(h);
    await h.dncRepo.addToDnc(TENANT, normalizePhone(CUSTOMER_PHONE), 'inbound-stop');
    const handler = buildStartOrApproveKeywordHandler({
      dncRepo: h.dncRepo,
      proposalReplyHandler: new ProposalReplyKeywordHandler(h.deps),
    });

    const result = await handler.handle(ctx('YES', CUSTOMER_PHONE));

    expect(result).toMatchObject({ handled: true, handler: 'start-reply', reason: 'opted_back_in' });
    expect(await h.dncRepo.isOnDnc(TENANT, normalizePhone(CUSTOMER_PHONE))).toBe(false);
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe(
      'ready_for_review',
    );
  });

  it("the OWNER's YES while on the DNC list is also opt-in only — never an approval", async () => {
    const h = makeHarness();
    const proposal = await seedPendingProposal(h);
    await h.dncRepo.addToDnc(TENANT, normalizePhone(OWNER_PHONE), 'inbound-stop');
    const handler = buildStartOrApproveKeywordHandler({
      dncRepo: h.dncRepo,
      proposalReplyHandler: new ProposalReplyKeywordHandler(h.deps),
    });

    const result = await handler.handle(ctx('YES', OWNER_PHONE));

    expect(result).toMatchObject({ reason: 'opted_back_in' });
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe(
      'ready_for_review',
    );
  });

  it('YES from the owner (not on DNC) approves the pending proposal', async () => {
    const h = makeHarness();
    const proposal = await seedPendingProposal(h);
    const handler = buildStartOrApproveKeywordHandler({
      dncRepo: h.dncRepo,
      proposalReplyHandler: new ProposalReplyKeywordHandler(h.deps),
    });

    const result = await handler.handle(ctx('YES', OWNER_PHONE));

    expect(result).toMatchObject({ handled: true, reason: 'approved' });
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe('approved');
  });

  it('YES from a non-owner not on DNC keeps the pre-existing start-reply behavior', async () => {
    const h = makeHarness();
    const proposal = await seedPendingProposal(h);
    const handler = buildStartOrApproveKeywordHandler({
      dncRepo: h.dncRepo,
      proposalReplyHandler: new ProposalReplyKeywordHandler(h.deps),
    });

    const result = await handler.handle(ctx('YES', CUSTOMER_PHONE));

    expect(result).toMatchObject({ handled: true, handler: 'start-reply' });
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe(
      'ready_for_review',
    );
  });

  it('START/UNSTOP never reach proposal approval, even from the owner', async () => {
    const h = makeHarness();
    const proposal = await seedPendingProposal(h);
    const handler = buildStartOrApproveKeywordHandler({
      dncRepo: h.dncRepo,
      proposalReplyHandler: new ProposalReplyKeywordHandler(h.deps),
    });

    for (const body of ['START', 'UNSTOP']) {
      const result = await handler.handle(ctx(body, OWNER_PHONE));
      expect(result).toMatchObject({ handled: true, handler: 'start-reply' });
    }
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe(
      'ready_for_review',
    );
  });
});

describe('registerProposalReplySms with compliance wiring (dispatch-level)', () => {
  beforeEach(() => {
    __resetKeywordRegistryForTests();
  });

  it('routes YES through the composite: opt-in for DNC senders, approval for the owner', async () => {
    const h = makeHarness();
    const proposal = await seedPendingProposal(h);
    await h.dncRepo.addToDnc(TENANT, normalizePhone(CUSTOMER_PHONE), 'inbound-stop');
    registerProposalReplySms(h.deps, { overwrite: true }, { dncRepo: h.dncRepo });

    const customer = await dispatchInboundSms(ctx('YES', CUSTOMER_PHONE));
    expect(customer).toMatchObject({ handler: 'start-reply', reason: 'opted_back_in' });
    expect(await h.dncRepo.isOnDnc(TENANT, normalizePhone(CUSTOMER_PHONE))).toBe(false);
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe(
      'ready_for_review',
    );

    const owner = await dispatchInboundSms(ctx('YES', OWNER_PHONE));
    expect(owner).toMatchObject({ handled: true, reason: 'approved' });
    expect((await h.proposalRepo.findById(TENANT, proposal.id))?.status).toBe('approved');
  });
});

/**
 * #1576 — an owner-line refund ("$100 refund paid in cash" for the Smiths)
 * drafted a record_refund whose `customerId` was the CALLER's own identity row
 * (the owner), so the approval card named the wrong customer. A refund belongs
 * to the customer whose invoice it is refunded against. And a refund where the
 * household came through as `customerName` never resolved its invoice at all:
 * the customer-anchored invoice lookup only offered OPEN invoices, while a
 * refund applies to money already received (a paid one).
 *
 * Seam: createVoiceTurnProcessor().speechTurn on the OWNER line with a
 * scripted gateway, over in-memory repos seeded from the corpus refund
 * script's fixtures and the fixture resolver Layer 2 wires.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as path from 'path';

import { createVoiceTurnProcessor } from '../../src/ai/voice-turn';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { loadScript, defaultCorpusRoot } from '../../src/ai/voice-quality/corpus/loader';
import { makeRepoBundle } from '../../src/ai/voice-quality/runner';
import { fixtureEntityResolverForBundle } from '../../src/ai/voice-quality/fixture-entity-resolver';
import type { LLMGateway, LLMRequest } from '../../src/ai/gateway/gateway';
import type { Customer } from '../../src/customers/customer';
import type { Job } from '../../src/jobs/job';
import type { Invoice } from '../../src/invoices/invoice';
import { missingFieldsFor } from '../../src/proposals/proposal';

/** Ids from the corpus script record-refund-known-customer.json. */
const OWNER_ROW = 'cust_02_record_refund_owner';
const SMITH_CUSTOMER = '00000000-0000-4000-8000-000002180001';
const SMITH_JOB = '00000000-0000-4000-8000-000002180002';
const SMITH_PAID_INVOICE = '00000000-0000-4000-8000-000002180003';

const stores: VoiceSessionStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.dispose();
});

function scriptedGateway(classifier: string): LLMGateway {
  return {
    complete: vi.fn(async (req: LLMRequest) => {
      const isConfirm = (req.metadata as { skill?: string } | undefined)?.skill === 'confirm_intent';
      return {
        content: isConfirm ? JSON.stringify({ answer: 'yes', reasoning: 'scripted' }) : classifier,
        model: 'mock',
        provider: 'mock',
        tokenUsage: { input: 1, output: 1, total: 2 },
        latencyMs: 1,
      };
    }),
  } as unknown as LLMGateway;
}

function withDates<T>(row: unknown, fields: string[]): T {
  const out = { ...(row as Record<string, unknown>) };
  for (const f of fields) if (typeof out[f] === 'string') out[f] = new Date(out[f] as string);
  return out as T;
}

interface Drafted {
  payload: Record<string, unknown>;
  missing: string[];
  spoken: string[];
}

async function ownerLineRefund(
  extractedEntities: Record<string, unknown>,
  extraInvoices: Array<Record<string, unknown>> = [],
  answers: string[] = ['Yes, that is right.'],
): Promise<Drafted> {
  const script = loadScript(
    path.join(defaultCorpusRoot(), '02-happy-booker', 'record-refund-known-customer.json'),
  );
  const tenantId = String((script.fixtures.tenant as { id: string }).id);
  const repos = makeRepoBundle('memory');
  for (const c of script.fixtures.customers) {
    await repos.customerRepo.create(withDates<Customer>(c, ['createdAt', 'updatedAt']));
  }
  for (const j of script.fixtures.jobs ?? []) {
    await repos.jobRepo.create(withDates<Job>(j, ['createdAt', 'updatedAt']));
  }
  for (const i of [...(script.fixtures.invoices ?? []), ...extraInvoices]) {
    await repos.invoiceRepo.create(
      withDates<Invoice>(i, ['createdAt', 'updatedAt', 'issuedAt', 'dueDate']),
    );
  }

  const store = new VoiceSessionStore({ startInterval: false });
  stores.push(store);
  const callSid = 'CA-1576-refund';
  const session = store.create(tenantId, 'telephony', { callSid, ownerSession: true });
  session.machine.dispatch({
    type: 'incoming_call',
    callSid,
    from: script.callerId!,
    to: '+15125550999',
    tenantId,
  });
  session.machine.dispatch({ type: 'greeted_ok' });
  session.machine.dispatch({ type: 'operator_session' });
  // The caller-ID identity the owner line carries: the owner's own row.
  session.customerId = OWNER_ROW;
  const processor = createVoiceTurnProcessor({
    store,
    gateway: scriptedGateway(
      JSON.stringify({ intentType: 'record_refund', confidence: 0.93, extractedEntities }),
    ),
    businessName: 'Test HVAC Co',
    systemActorId: 'test-actor',
    auditRepo: repos.auditRepo,
    proposalRepo: repos.proposalRepo,
    customerRepo: repos.customerRepo,
    jobRepo: repos.jobRepo,
    invoiceRepo: repos.invoiceRepo,
    entityResolver: fixtureEntityResolverForBundle(repos, {
      tenantId,
      timezone: 'America/Los_Angeles',
    }),
  });
  const spoken: string[] = [];
  const turn = async (speechResult: string) => {
    const fx = await processor.speechTurn({ session, speechResult, callSid, tenantId });
    for (const e of fx) {
      if (e.type === 'tts_play' && typeof (e.payload as { text?: unknown }).text === 'string') {
        spoken.push((e.payload as { text: string }).text);
      }
    }
  };

  await turn(script.turns[0].caller);
  for (const answer of answers) await turn(answer);

  const [draft] = await repos.proposalRepo.findByTenant(tenantId);
  return {
    payload: (draft?.payload ?? {}) as Record<string, unknown>,
    missing: draft ? missingFieldsFor(draft) : ['<no draft>'],
    spoken,
  };
}

describe('#1576 — an owner-line refund is drafted for the refunded customer', () => {
  it('"the Smiths" as the invoice reference: the card customer is John Smith, not the owner', async () => {
    const draft = await ownerLineRefund({
      jobReference: 'the Smiths',
      amount: 10000,
      refundMethod: 'cash',
    });

    expect(draft.payload.invoiceId).toBe(SMITH_PAID_INVOICE);
    expect(draft.payload.customerId).toBe(SMITH_CUSTOMER);
    expect(draft.missing).toEqual([]);
  });

  it('"the Smiths" as the customer: the refund lands on their PAID invoice', async () => {
    const draft = await ownerLineRefund({
      customerName: 'the Smiths',
      amount: 10000,
      refundMethod: 'cash',
    });

    expect(draft.payload.invoiceId).toBe(SMITH_PAID_INVOICE);
    expect(draft.payload.customerId).toBe(SMITH_CUSTOMER);
    expect(draft.missing).toEqual([]);
  });

  it('two paid Smith invoices: the owner is asked which one — no invoice is picked', async () => {
    const secondPaid = {
      id: '00000000-0000-4000-8000-000015760001',
      tenantId: 't_02_record_refund',
      jobId: SMITH_JOB,
      estimateId: null,
      invoiceNumber: 'INV-2181',
      status: 'paid',
      lineItems: [{ description: 'Condenser fan motor', quantity: 1, unitPriceCents: 45000 }],
      totals: { subtotalCents: 45000, discountCents: 0, taxCents: 0, totalCents: 45000 },
      amountPaidCents: 45000,
      amountDueCents: 0,
      issuedAt: '2026-04-20T10:00:00.000Z',
      dueDate: '2026-05-20T10:00:00.000Z',
      customerMessage: null,
      createdBy: 'user_seed',
      createdAt: '2026-04-20T10:00:00.000Z',
      updatedAt: '2026-04-21T10:00:00.000Z',
    };
    const draft = await ownerLineRefund(
      { customerName: 'the Smiths', amount: 10000, refundMethod: 'cash' },
      [secondPaid],
      [],
    );

    expect(draft.missing).toEqual(['<no draft>']);
    const question = draft.spoken.join(' ');
    expect(question).toContain('INV-2180');
    expect(question).toContain('INV-2181');
  });
});

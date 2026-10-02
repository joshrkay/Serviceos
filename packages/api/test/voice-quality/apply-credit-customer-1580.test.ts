/**
 * #1580 — the same class as #1576, for apply_credit on the OWNER line: the
 * credit's approval card must name the customer whose invoice is credited
 * (invoice → job → customer), never the owner's own caller-ID identity row.
 *
 * Seam: createVoiceTurnProcessor().speechTurn on the owner line with a
 * scripted gateway, over in-memory repos seeded from the corpus apply-credit
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

/** Ids from the corpus script apply-credit-known-customer.json. */
const OWNER_ROW = 'cust_02_apply_credit_owner';
const HENDERSON_CUSTOMER = '00000000-0000-4000-8000-000002160001';
const HENDERSON_INVOICE = '00000000-0000-4000-8000-000002160003';

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

async function ownerLineCredit(
  extractedEntities: Record<string, unknown>,
  extraInvoices: Array<Record<string, unknown>> = [],
  answers: string[] = ['Yes, that is right.'],
): Promise<Drafted> {
  const script = loadScript(
    path.join(defaultCorpusRoot(), '02-happy-booker', 'apply-credit-known-customer.json'),
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
  const callSid = 'CA-1580-credit';
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
      JSON.stringify({ intentType: 'apply_credit', confidence: 0.93, extractedEntities }),
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

describe('#1580 — an owner-line credit is drafted for the credited customer', () => {
  it('"the Henderson invoice": the card customer is Tom Henderson, not the owner', async () => {
    const draft = await ownerLineCredit({
      jobReference: 'the Henderson invoice',
      amount: 5000,
      creditReason: 'callback',
    });

    expect(draft.payload.invoiceId).toBe(HENDERSON_INVOICE);
    expect(draft.payload.customerId).toBe(HENDERSON_CUSTOMER);
  });
});

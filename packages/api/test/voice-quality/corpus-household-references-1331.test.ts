/**
 * #1331 (Layer 2 run 36925905917) — create-change-order and record-refund
 * both ended "I've drafted that, but it still needs a few details": the
 * change order gated on `jobId`, the refund on `invoiceId`. The scripts'
 * worlds held only the owner's own record — no Garcias, no Smiths — so nothing
 * could lift either gate, and the owner names a household in the plural
 * ("the Garcias", "the Smiths"), which no word-matching resolver matched.
 *
 * With the household and its one job / one paid invoice in the fixture, a
 * fully specified request drafts complete — through the production phone
 * resolution path (the fixture resolver Layer 2 wires, PgEntityResolver's
 * contract), never a guessed id.
 *
 * Seam: createVoiceTurnProcessor().speechTurn on the OWNER line with a
 * scripted gateway emitting the extraction the live classifier read back on
 * that run, over in-memory repos seeded from the corpus script's fixtures.
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

/** The ids the corpus fixtures give the household's records. */
const GARCIA_JOB = '00000000-0000-4000-8000-000002170002';
const SMITH_INVOICE = '00000000-0000-4000-8000-000002180003';

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

async function ownerLineDraft(
  file: string,
  intentType: string,
  extractedEntities: Record<string, unknown>,
): Promise<{ proposalType: string; payload: Record<string, unknown>; missing: string[] }> {
  const script = loadScript(path.join(defaultCorpusRoot(), '02-happy-booker', file));
  const tenantId = String((script.fixtures.tenant as { id: string }).id);
  const repos = makeRepoBundle('memory');
  for (const c of script.fixtures.customers) await repos.customerRepo.create(withDates<Customer>(c, ['createdAt', 'updatedAt']));
  for (const j of script.fixtures.jobs ?? []) await repos.jobRepo.create(withDates<Job>(j, ['createdAt', 'updatedAt']));
  for (const i of script.fixtures.invoices ?? []) {
    await repos.invoiceRepo.create(withDates<Invoice>(i, ['createdAt', 'updatedAt', 'issuedAt', 'dueDate']));
  }

  const store = new VoiceSessionStore({ startInterval: false });
  stores.push(store);
  const callSid = `CA-1331-${intentType}`;
  const session = store.create(tenantId, 'telephony', { callSid, ownerSession: true });
  session.machine.dispatch({ type: 'incoming_call', callSid, from: script.callerId!, to: '+15125550999', tenantId });
  session.machine.dispatch({ type: 'greeted_ok' });
  session.machine.dispatch({ type: 'operator_session' });
  const processor = createVoiceTurnProcessor({
    store,
    gateway: scriptedGateway(JSON.stringify({ intentType, confidence: 0.93, extractedEntities })),
    businessName: 'Test HVAC Co',
    systemActorId: 'test-actor',
    auditRepo: repos.auditRepo,
    proposalRepo: repos.proposalRepo,
    customerRepo: repos.customerRepo,
    jobRepo: repos.jobRepo,
    entityResolver: fixtureEntityResolverForBundle(repos, { tenantId, timezone: 'America/Los_Angeles' }),
  });
  const turn = (speechResult: string) => processor.speechTurn({ session, speechResult, callSid, tenantId });

  await turn(script.turns[0].caller);
  await turn('Yes, that is right.');

  const [draft] = await repos.proposalRepo.findByTenant(tenantId);
  expect(draft).toBeDefined();
  return {
    proposalType: draft!.proposalType,
    payload: draft!.payload as Record<string, unknown>,
    missing: missingFieldsFor(draft!),
  };
}

describe('#1331 — a household named in the plural resolves in the corpus world', () => {
  it('change order "for the Garcias" (named as the customer) drafts on the Garcia job, complete', async () => {
    const draft = await ownerLineDraft('create-change-order-known-customer.json', 'create_change_order', {
      customerName: 'the Garcias',
      changeOrderDescription: 'a second zone added',
      amount: 180000,
    });

    expect(draft.proposalType).toBe('create_change_order');
    expect(draft.payload.jobId).toBe(GARCIA_JOB);
    expect(draft.missing).toEqual([]);
  });

  it('change order with "the Garcias" as the job reference drafts on the Garcia job, complete', async () => {
    const draft = await ownerLineDraft('create-change-order-known-customer.json', 'create_change_order', {
      jobReference: 'the Garcias',
      changeOrderDescription: 'a second zone added',
      amount: 180000,
    });

    expect(draft.payload.jobId).toBe(GARCIA_JOB);
    expect(draft.missing).toEqual([]);
  });

  it('refund "the Smiths" 100 dollars in cash drafts on the Smiths\' paid invoice, complete', async () => {
    const draft = await ownerLineDraft('record-refund-known-customer.json', 'record_refund', {
      jobReference: 'the Smiths',
      amount: 10000,
      refundMethod: 'cash',
      refundReason: "the recharge didn't hold",
    });

    expect(draft.proposalType).toBe('record_refund');
    expect(draft.payload.invoiceId).toBe(SMITH_INVOICE);
    expect(draft.payload.amountCents).toBe(10000);
    expect(draft.missing).toEqual([]);
  });
});

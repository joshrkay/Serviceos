/**
 * #1331 (Layer 2, #1548's remaining-items table) — apply-credit gated on
 * `invoiceId` because "the Henderson invoice" had nothing behind it: the
 * script's world held only the owner's own record. With the Henderson
 * customer and their ONE open invoice in the fixture, the reference is
 * unambiguous and the owner-line draft carries that invoice — through the
 * production phone resolution path (the fixture resolver Layer 2 wires, the
 * same contract as PgEntityResolver), never a guessed id.
 *
 * Seam: createVoiceTurnProcessor().speechTurn on the OWNER line with a
 * scripted gateway (the classifier emits the taxonomy's own extraction for
 * this utterance — jobReference + amount), over in-memory repos seeded from
 * the corpus script's fixtures.
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

describe('#1331 — apply-credit: "the Henderson invoice" resolves in the corpus world', () => {
  it('the owner-line draft carries the Henderson open invoice, not an invoiceId gate', async () => {
    const script = loadScript(
      path.join(defaultCorpusRoot(), '02-happy-booker', 'apply-credit-known-customer.json'),
    );
    const tenantId = String((script.fixtures.tenant as { id: string }).id);
    const repos = makeRepoBundle('memory');
    for (const c of script.fixtures.customers) await repos.customerRepo.create(withDates<Customer>(c, ['createdAt', 'updatedAt']));
    for (const j of script.fixtures.jobs ?? []) await repos.jobRepo.create(withDates<Job>(j, ['createdAt', 'updatedAt']));
    for (const i of script.fixtures.invoices ?? []) {
      await repos.invoiceRepo.create(withDates<Invoice>(i, ['createdAt', 'updatedAt', 'issuedAt', 'dueDate']));
    }
    const hendersonInvoice = (await repos.invoiceRepo.findByTenant(tenantId)).find((i) => i.status === 'open');

    const store = new VoiceSessionStore({ startInterval: false });
    stores.push(store);
    const callSid = 'CA-1331-credit';
    const session = store.create(tenantId, 'telephony', { callSid, ownerSession: true });
    session.machine.dispatch({ type: 'incoming_call', callSid, from: script.callerId!, to: '+15125550999', tenantId });
    session.machine.dispatch({ type: 'greeted_ok' });
    session.machine.dispatch({ type: 'operator_session' });
    const processor = createVoiceTurnProcessor({
      store,
      gateway: scriptedGateway(
        JSON.stringify({
          intentType: 'apply_credit',
          confidence: 0.93,
          extractedEntities: { jobReference: 'the Henderson invoice', amount: 5000, creditReason: 'callback' },
        }),
      ),
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
    expect(hendersonInvoice).toBeDefined();
    expect(draft?.proposalType).toBe('apply_credit');
    expect((draft?.payload as { invoiceId?: string }).invoiceId).toBe(hendersonInvoice!.id);
    expect(missingFieldsFor(draft!)).not.toContain('invoiceId');
  });
});

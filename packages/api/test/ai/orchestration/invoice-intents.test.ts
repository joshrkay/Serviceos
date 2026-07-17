/**
 * P22-002 — invoice-intents: issue vs send unification.
 *
 * Verifies (1) the classifier prompt documents the issue_invoice /
 * send_invoice disambiguation (issue = make official/payable; send =
 * deliver to customer) with the required example phrasings, (2) the
 * classifier routes 5+ issue phrasings and distinguishes issue from
 * send end-to-end (mocked gateway), and (3) the default task router
 * registers an issue_invoice route that produces a typed proposal.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  classifyIntent,
  IntentType,
} from '../../../src/ai/orchestration/intent-classifier';
import {
  createDefaultTaskRouter,
  IssueInvoiceTaskHandler,
} from '../../../src/ai/orchestration/task-router';
import { LLMGateway, LLMResponse } from '../../../src/ai/gateway/gateway';
import { issueInvoicePayloadSchema } from '../../../src/proposals/contracts/issue-invoice';
import { missingFieldsFor } from '../../../src/proposals/proposal';
import { approveProposal } from '../../../src/proposals/actions';
import { InMemoryProposalRepository } from '../../../src/proposals/proposal';
import { ValidationError } from '../../../src/shared/errors';

function mockGateway(jsonContent: string): LLMGateway {
  return {
    complete: vi.fn(async () => ({
      content: jsonContent,
      model: 'mock-model',
      provider: 'mock',
      tokenUsage: { input: 100, output: 50, total: 150 },
      latencyMs: 42,
    } satisfies LLMResponse)),
  } as unknown as LLMGateway;
}

async function capturePrompt(): Promise<string> {
  const gateway = mockGateway(
    JSON.stringify({ intentType: 'issue_invoice', confidence: 0.9 }),
  );
  await classifyIntent('Issue invoice 1024', { tenantId: 't-1' }, gateway);
  const call = (gateway.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
  return call.messages
    .filter((m: { role: string }) => m.role === 'system')
    .map((m: { content: string }) => m.content)
    .join('\n');
}

describe('P22-002 invoice-intents — prompt disambiguation', () => {
  it('documents issue = make official/payable vs send = deliver', async () => {
    const prompt = await capturePrompt();
    expect(prompt).toMatch(/issue_invoice/);
    expect(prompt).toMatch(/send_invoice/);
    expect(prompt).toMatch(/make.*official/i);
    expect(prompt).toMatch(/deliver/i);
    expect(prompt).toMatch(/draft → open/);
  });

  it('includes issue phrasings: issue, finalize, send out the bill', async () => {
    const prompt = await capturePrompt();
    expect(prompt).toContain('Issue invoice 1024');
    expect(prompt).toContain('Finalize the Smith invoice');
    expect(prompt).toContain('Send out the bill for the Acme job');
    expect(prompt).toContain('Make the Jones invoice official');
  });

  it('steers channel/recipient phrasings to send_invoice', async () => {
    const prompt = await capturePrompt();
    expect(prompt).toMatch(/channel or recipient\s+is named, prefer\s+send_invoice/i);
    expect(prompt).toContain('Resend the Acme invoice by email');
  });
});

describe('P22-002 invoice-intents — classification routing', () => {
  const issuePhrasings: Array<{ transcript: string; entities?: Record<string, unknown> }> = [
    { transcript: 'Issue invoice 1024', entities: { jobReference: '1024' } },
    { transcript: 'Issue the Acme invoice', entities: { jobReference: 'Acme' } },
    { transcript: 'Finalize the Smith invoice', entities: { jobReference: 'Smith' } },
    { transcript: 'Make that invoice official' },
    { transcript: 'Send out the bill for the Acme job', entities: { jobReference: 'Acme' } },
    { transcript: 'Send the invoice we just drafted' },
  ];

  it.each(issuePhrasings)(
    'routes "$transcript" to issue_invoice',
    async ({ transcript, entities }) => {
      const gateway = mockGateway(
        JSON.stringify({
          intentType: 'issue_invoice',
          confidence: 0.9,
          reasoning: 'issue/finalize a draft invoice',
          extractedEntities: entities ?? {},
        }),
      );
      const out = await classifyIntent(transcript, { tenantId: 't-1' }, gateway);
      expect(out.intentType).toBe<IntentType>('issue_invoice');
      expect(out.confidence).toBeGreaterThanOrEqual(0.9);
    },
  );

  it('distinguishes send_invoice when a channel is named', async () => {
    const gateway = mockGateway(
      JSON.stringify({
        intentType: 'send_invoice',
        confidence: 0.91,
        extractedEntities: { jobReference: 'INV-0042', sendChannel: 'email' },
      }),
    );
    const out = await classifyIntent(
      'Email invoice INV-0042 to Sarah',
      { tenantId: 't-1' },
      gateway,
    );
    expect(out.intentType).toBe<IntentType>('send_invoice');
  });
});

describe('P22-002 invoice-intents — task router issue_invoice route', () => {
  it('default router registers issue_invoice', () => {
    const router = createDefaultTaskRouter();
    expect(router.listRegisteredTasks()).toContain('issue_invoice');
  });

  it('builds an issue_invoice proposal whose payload passes the Zod contract', async () => {
    const router = createDefaultTaskRouter();
    const { proposal, taskType } = await router.route('issue_invoice', {
      tenantId: 't-1',
      userId: 'u-1',
      message: 'Issue invoice INV-0042',
      existingEntities: { jobReference: 'INV-0042' },
    });

    expect(taskType).toBe('issue_invoice');
    expect(proposal.proposalType).toBe('issue_invoice');
    expect(proposal.tenantId).toBe('t-1');
    const parsed = issueInvoicePayloadSchema.safeParse(proposal.payload);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.invoiceId).toBe('INV-0042');
  });

  it('omits invoiceId (failing the contract downstream) when no reference extracted', async () => {
    const handler = new IssueInvoiceTaskHandler();
    const { proposal } = await handler.handle({
      tenantId: 't-1',
      userId: 'u-1',
      message: 'Issue the invoice',
    });
    expect(issueInvoicePayloadSchema.safeParse(proposal.payload).success).toBe(false);
  });

  it('gates the no-reference case with missingFields so it never lands approved', async () => {
    const handler = new IssueInvoiceTaskHandler();
    const { proposal } = await handler.handle({
      tenantId: 't-1',
      userId: 'u-1',
      message: 'Issue the invoice',
    });

    expect(missingFieldsFor(proposal)).toEqual(['invoiceId']);
    // decideInitialStatus forces 'draft' regardless of trust tier/confidence
    // whenever missingFields is non-empty.
    expect(proposal.status).toBe('draft');

    // Simulate the assistant route's "promote drafts to ready_for_review"
    // step, then confirm approveProposal still refuses it — the operator
    // must fill the gap (e.g. via editProposal) before the invoice can be
    // issued; it can never reach a doomed execution.
    const repo = new InMemoryProposalRepository();
    await repo.create(proposal);
    await repo.updateStatus('t-1', proposal.id, 'ready_for_review');

    await expect(
      approveProposal(repo, 't-1', proposal.id, 'u-1', 'owner'),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('with a reference extracted, the proposal is unaffected by the missingFields gate', async () => {
    const handler = new IssueInvoiceTaskHandler();
    const { proposal } = await handler.handle({
      tenantId: 't-1',
      userId: 'u-1',
      message: 'Issue invoice INV-0042',
      existingEntities: { jobReference: 'INV-0042' },
    });

    expect(missingFieldsFor(proposal)).toEqual([]);

    const repo = new InMemoryProposalRepository();
    await repo.create(proposal);
    await repo.updateStatus('t-1', proposal.id, 'ready_for_review');

    const approved = await approveProposal(repo, 't-1', proposal.id, 'u-1', 'owner');
    expect(approved.status).toBe('approved');
  });
});

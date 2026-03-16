import { EstimateTaskHandler } from '../../src/ai/tasks/estimate-task';
import { LLMGateway } from '../../src/ai/gateway/gateway';
import type { LLMProvider, LLMGatewayConfig } from '../../src/ai/gateway/gateway';
import { StubProvider } from '../../src/ai/gateway/providers';
import { TaskContext } from '../../src/ai/tasks/task-handlers';

function makeGateway(stub: StubProvider): LLMGateway {
  const providers = new Map<string, LLMProvider>();
  providers.set('stub', stub);
  const config: LLMGatewayConfig = {
    defaultProvider: 'stub',
    defaultModel: 'test-model',
  };
  return new LLMGateway(config, providers);
}

function makeContext(overrides: Partial<TaskContext> = {}): TaskContext {
  return {
    tenantId: 'tenant-1',
    message: 'Generate an estimate for plumbing repair',
    userId: 'user-1',
    ...overrides,
  };
}

const validEstimateJson = JSON.stringify({
  customerId: '550e8400-e29b-41d4-a716-446655440000',
  jobId: '660e8400-e29b-41d4-a716-446655440000',
  lineItems: [
    { description: 'Pipe repair', quantity: 2, unitPrice: 75.0, category: 'plumbing' },
    { description: 'Labor', quantity: 3, unitPrice: 50.0 },
  ],
  notes: 'Estimate for kitchen plumbing',
  validUntil: '2026-04-15',
  confidence_score: 0.85,
});

describe('P2-016 — Estimate draft proposal generation', () => {
  it('happy path — generates estimate proposal from context', async () => {
    const stub = new StubProvider('stub');
    stub.setResponse({ content: validEstimateJson });
    const gateway = makeGateway(stub);
    const handler = new EstimateTaskHandler(gateway);

    const result = await handler.handle(makeContext());

    expect(result.taskType).toBe('draft_estimate');
    expect(result.proposal.proposalType).toBe('draft_estimate');
    expect(result.proposal.status).toBe('draft');
    expect(result.proposal.tenantId).toBe('tenant-1');
    expect(result.proposal.createdBy).toBe('user-1');

    const payload = result.proposal.payload;
    expect(payload.customerId).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(payload.jobId).toBe('660e8400-e29b-41d4-a716-446655440000');
    expect(Array.isArray(payload.lineItems)).toBe(true);
    expect((payload.lineItems as unknown[]).length).toBe(2);
    expect(payload.notes).toBe('Estimate for kitchen plumbing');
  });

  it('happy path — sets confidence from AI response', async () => {
    const stub = new StubProvider('stub');
    stub.setResponse({ content: validEstimateJson });
    const gateway = makeGateway(stub);
    const handler = new EstimateTaskHandler(gateway);

    const result = await handler.handle(makeContext());

    expect(result.proposal.confidenceScore).toBe(0.85);
    expect(result.proposal.confidenceFactors).toBeDefined();
    expect(result.proposal.confidenceFactors!.length).toBeGreaterThan(0);
    expect(result.proposal.confidenceFactors).toContain('model_provided_confidence');
  });

  it('validation — handles missing context gracefully', async () => {
    const stub = new StubProvider('stub');
    stub.setResponse({
      content: JSON.stringify({
        customerId: '550e8400-e29b-41d4-a716-446655440000',
        lineItems: [{ description: 'Basic service', quantity: 1, unitPrice: 100 }],
      }),
    });
    const gateway = makeGateway(stub);
    const handler = new EstimateTaskHandler(gateway);

    const context = makeContext({ existingEntities: undefined, conversationId: undefined });
    const result = await handler.handle(context);

    expect(result.proposal.proposalType).toBe('draft_estimate');
    expect(result.proposal.sourceContext).toBeUndefined();

    const lastRequest = stub.getLastRequest();
    expect(lastRequest).toBeDefined();
    expect(lastRequest!.taskType).toBe('draft_estimate');
  });

  it('mock provider test — stub provider returns estimate JSON', async () => {
    const stub = new StubProvider('stub');
    stub.setResponse({ content: validEstimateJson });
    const gateway = makeGateway(stub);
    const handler = new EstimateTaskHandler(gateway);

    const context = makeContext({
      conversationId: 'conv-123',
      existingEntities: { customerName: 'Acme Corp' },
    });
    const result = await handler.handle(context);

    const lastRequest = stub.getLastRequest();
    expect(lastRequest).toBeDefined();
    expect(lastRequest!.taskType).toBe('draft_estimate');
    expect(lastRequest!.responseFormat).toBe('json');
    expect(lastRequest!.messages.length).toBe(2);
    expect(lastRequest!.messages[0].role).toBe('system');
    expect(lastRequest!.messages[1].role).toBe('user');
    expect(lastRequest!.messages[1].content).toContain('Acme Corp');

    expect(result.proposal.sourceContext).toEqual({ conversationId: 'conv-123' });
  });

  it('malformed AI output handled gracefully — invalid JSON creates partial proposal', async () => {
    const stub = new StubProvider('stub');
    stub.setResponse({ content: 'This is not valid JSON at all' });
    const gateway = makeGateway(stub);
    const handler = new EstimateTaskHandler(gateway);

    const result = await handler.handle(makeContext());

    expect(result.proposal.proposalType).toBe('draft_estimate');
    expect(result.proposal.status).toBe('draft');
    expect(result.proposal.payload.lineItems).toEqual([]);
    expect(result.proposal.payload.notes).toBe('AI output could not be parsed');
  });

  it('malformed AI output handled gracefully — missing required fields handled', async () => {
    const stub = new StubProvider('stub');
    stub.setResponse({
      content: JSON.stringify({ notes: 'Some notes but no lineItems or customerId' }),
    });
    const gateway = makeGateway(stub);
    const handler = new EstimateTaskHandler(gateway);

    const result = await handler.handle(makeContext());

    expect(result.proposal.proposalType).toBe('draft_estimate');
    expect(result.proposal.payload.lineItems).toEqual([]);
    expect(result.proposal.payload.customerId).toBeUndefined();
    expect(result.proposal.payload.notes).toBe('Some notes but no lineItems or customerId');
  });
});

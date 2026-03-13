import {
  InvoiceTaskHandler,
  tryParseInvoiceJson,
  buildPartialInvoicePayload,
  INVOICE_SYSTEM_PROMPT,
} from '../../../src/ai/tasks/invoice-task';
import { LLMGateway, LLMResponse } from '../../../src/ai/gateway/gateway';
import { TaskContext } from '../../../src/ai/tasks/task-handlers';

function createMockGateway(responseContent: string): LLMGateway {
  return {
    complete: jest.fn().mockResolvedValue({
      content: responseContent,
      model: 'test-model',
      provider: 'test-provider',
      tokenUsage: { input: 10, output: 20, total: 30 },
      latencyMs: 100,
    } as LLMResponse),
  } as unknown as LLMGateway;
}

const validAiOutput = {
  customerId: '00000000-0000-0000-0000-000000000001',
  jobId: '00000000-0000-0000-0000-000000000002',
  lineItems: [
    { description: 'AC Repair', quantity: 2, unitPrice: 7500, category: 'labor' },
    { description: 'Parts', quantity: 1, unitPrice: 3000, category: 'material' },
  ],
  discountCents: 500,
  taxRateBps: 825,
  customerMessage: 'Thank you for choosing us',
  internalNotes: 'Rush job',
  confidence_score: 0.85,
};

const baseContext: TaskContext = {
  tenantId: 'tenant-1',
  message: 'Generate invoice for AC repair job',
  conversationId: 'conv-1',
  userId: 'user-1',
};

describe('P5-003A — Invoice draft generation from work context', () => {
  describe('InvoiceTaskHandler', () => {
    it('happy path — handler returns proposal with draft_invoice type and parsed payload', async () => {
      const gateway = createMockGateway(JSON.stringify(validAiOutput));
      const handler = new InvoiceTaskHandler(gateway);

      const result = await handler.handle(baseContext);

      expect(result.taskType).toBe('draft_invoice');
      expect(result.proposal.proposalType).toBe('draft_invoice');
      expect(result.proposal.status).toBe('draft');
      expect(result.proposal.tenantId).toBe('tenant-1');
      expect(result.proposal.payload.customerId).toBe('00000000-0000-0000-0000-000000000001');
      expect(result.proposal.payload.jobId).toBe('00000000-0000-0000-0000-000000000002');
      expect(Array.isArray(result.proposal.payload.lineItems)).toBe(true);
      expect((result.proposal.payload.lineItems as unknown[]).length).toBe(2);
      expect(result.proposal.payload.discountCents).toBe(500);
      expect(result.proposal.payload.taxRateBps).toBe(825);
      expect(result.proposal.payload.customerMessage).toBe('Thank you for choosing us');
      expect(result.proposal.payload.internalNotes).toBe('Rush job');
    });

    it('happy path — gateway called with correct system prompt and params', async () => {
      const gateway = createMockGateway(JSON.stringify(validAiOutput));
      const handler = new InvoiceTaskHandler(gateway);

      await handler.handle(baseContext);

      expect(gateway.complete).toHaveBeenCalledTimes(1);
      const call = (gateway.complete as jest.Mock).mock.calls[0][0];
      expect(call.taskType).toBe('draft_invoice');
      expect(call.responseFormat).toBe('json');
      expect(call.messages[0].role).toBe('system');
      expect(call.messages[0].content).toBe(INVOICE_SYSTEM_PROMPT);
      expect(call.messages[1].role).toBe('user');
      expect(call.messages[1].content).toContain('Generate invoice for AC repair job');
    });

    it('validation — empty message still produces proposal', async () => {
      const gateway = createMockGateway(JSON.stringify(validAiOutput));
      const handler = new InvoiceTaskHandler(gateway);

      const result = await handler.handle({
        tenantId: 'tenant-1',
        message: '',
        userId: 'user-1',
      });

      expect(result.proposal).toBeDefined();
      expect(result.taskType).toBe('draft_invoice');
    });

    it('tenant isolation — proposal has correct tenantId', async () => {
      const gateway = createMockGateway(JSON.stringify(validAiOutput));
      const handler = new InvoiceTaskHandler(gateway);

      const r1 = await handler.handle({ tenantId: 'tenant-A', message: 'Test', userId: 'u1' });
      const r2 = await handler.handle({ tenantId: 'tenant-B', message: 'Test', userId: 'u2' });

      expect(r1.proposal.tenantId).toBe('tenant-A');
      expect(r2.proposal.tenantId).toBe('tenant-B');
      expect(r1.proposal.id).not.toBe(r2.proposal.id);
    });

    it('mock provider — gateway.complete called with correct params', async () => {
      const gateway = createMockGateway(JSON.stringify(validAiOutput));
      const handler = new InvoiceTaskHandler(gateway);

      await handler.handle(baseContext);

      expect(gateway.complete).toHaveBeenCalledWith(
        expect.objectContaining({
          taskType: 'draft_invoice',
          responseFormat: 'json',
        }),
      );
    });

    it('malformed AI output — non-JSON response handled gracefully', async () => {
      const gateway = createMockGateway('This is not JSON at all');
      const handler = new InvoiceTaskHandler(gateway);

      const result = await handler.handle(baseContext);

      expect(result.proposal).toBeDefined();
      expect(result.taskType).toBe('draft_invoice');
      expect(result.proposal.payload.lineItems).toEqual([]);
      expect(result.proposal.payload.notes).toBe('AI output could not be parsed');
    });

    it('malformed AI output — partial JSON handled with empty lineItems', async () => {
      const gateway = createMockGateway(JSON.stringify({ customerId: 'cust-1' }));
      const handler = new InvoiceTaskHandler(gateway);

      const result = await handler.handle(baseContext);

      expect(result.proposal.payload.customerId).toBe('cust-1');
      expect(result.proposal.payload.lineItems).toEqual([]);
    });

    it('confidence scoring — uses confidence_score from AI output', async () => {
      const gateway = createMockGateway(JSON.stringify(validAiOutput));
      const handler = new InvoiceTaskHandler(gateway);

      const result = await handler.handle(baseContext);

      expect(result.proposal.confidenceScore).toBe(0.85);
      expect(result.proposal.confidenceFactors).toBeDefined();
      expect(result.proposal.confidenceFactors!.length).toBeGreaterThan(0);
    });

    it('confidence scoring — defaults to 0.5 when no confidence_score in AI output', async () => {
      const noConfidence = { ...validAiOutput };
      delete (noConfidence as Record<string, unknown>).confidence_score;
      const gateway = createMockGateway(JSON.stringify(noConfidence));
      const handler = new InvoiceTaskHandler(gateway);

      const result = await handler.handle(baseContext);

      expect(result.proposal.confidenceScore).toBe(0.5);
    });

    it('context — includes existingEntities in user message when present', async () => {
      const gateway = createMockGateway(JSON.stringify(validAiOutput));
      const handler = new InvoiceTaskHandler(gateway);

      const context: TaskContext = {
        ...baseContext,
        existingEntities: { customer: { name: 'John Doe' } },
      };

      await handler.handle(context);

      const call = (gateway.complete as jest.Mock).mock.calls[0][0];
      expect(call.messages[1].content).toContain('Context entities');
      expect(call.messages[1].content).toContain('John Doe');
    });

    it('sourceContext — includes conversationId when provided', async () => {
      const gateway = createMockGateway(JSON.stringify(validAiOutput));
      const handler = new InvoiceTaskHandler(gateway);

      const result = await handler.handle(baseContext);

      expect(result.proposal.sourceContext).toEqual({ conversationId: 'conv-1' });
    });

    it('sourceContext — omitted when no conversationId', async () => {
      const gateway = createMockGateway(JSON.stringify(validAiOutput));
      const handler = new InvoiceTaskHandler(gateway);

      const result = await handler.handle({
        tenantId: 'tenant-1',
        message: 'Invoice',
        userId: 'user-1',
      });

      expect(result.proposal.sourceContext).toBeUndefined();
    });
  });

  describe('tryParseInvoiceJson', () => {
    it('parses valid JSON object', () => {
      expect(tryParseInvoiceJson('{"a": 1}')).toEqual({ a: 1 });
    });

    it('returns null for invalid JSON', () => {
      expect(tryParseInvoiceJson('not json')).toBeNull();
    });

    it('returns null for JSON string primitive', () => {
      expect(tryParseInvoiceJson('"just a string"')).toBeNull();
    });

    it('returns null for JSON number', () => {
      expect(tryParseInvoiceJson('42')).toBeNull();
    });
  });

  describe('buildPartialInvoicePayload', () => {
    it('builds payload from parsed AI output', () => {
      const result = buildPartialInvoicePayload(validAiOutput as unknown as Record<string, unknown>);
      expect(result.customerId).toBe('00000000-0000-0000-0000-000000000001');
      expect(result.jobId).toBe('00000000-0000-0000-0000-000000000002');
      expect(result.lineItems).toHaveLength(2);
      expect(result.discountCents).toBe(500);
    });

    it('returns fallback for null input', () => {
      const result = buildPartialInvoicePayload(null);
      expect(result.lineItems).toEqual([]);
      expect(result.notes).toBe('AI output could not be parsed');
    });

    it('defaults lineItems to empty array when missing', () => {
      const result = buildPartialInvoicePayload({ customerId: 'cust-1' });
      expect(result.lineItems).toEqual([]);
    });

    it('ignores non-string customerId', () => {
      const result = buildPartialInvoicePayload({ customerId: 123, lineItems: [] });
      expect(result.customerId).toBeUndefined();
    });
  });
});

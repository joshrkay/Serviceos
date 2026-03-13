import { LLMGateway } from '../../../src/ai/gateway/gateway';
import { createMockLLMGateway } from '../../../src/ai/gateway/factory';
import type { ChatRequest } from '../../../src/ai/gateway/types';

describe('LLMGateway', () => {
  describe('chat', () => {
    it('should return content from the provider', async () => {
      const { gateway, provider } = createMockLLMGateway('{"result": "ok"}');
      const response = await gateway.chat({
        taskType: 'classify_intent',
        messages: [{ role: 'user', content: 'Book a job for tomorrow' }],
      });
      expect(response.content).toBe('{"result": "ok"}');
      expect(response.tokenUsage).toBeDefined();
      expect(response.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should prepend system prompt from route config', async () => {
      const { gateway, provider } = createMockLLMGateway('{}');
      await gateway.chat({
        taskType: 'classify_intent',
        messages: [{ role: 'user', content: 'hello' }],
      });
      const calls = provider.getCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0].messages[0].role).toBe('system');
      expect(calls[0].messages[1].role).toBe('user');
    });

    it('should not duplicate system prompt if already present', async () => {
      const { gateway, provider } = createMockLLMGateway('{}');
      await gateway.chat({
        taskType: 'classify_intent',
        messages: [
          { role: 'system', content: 'custom system' },
          { role: 'user', content: 'hello' },
        ],
      });
      const calls = provider.getCalls();
      const systemMessages = calls[0].messages.filter((m) => m.role === 'system');
      expect(systemMessages).toHaveLength(1);
      expect(systemMessages[0].content).toBe('custom system');
    });

    it('should use modelOverride when provided', async () => {
      const { gateway, provider } = createMockLLMGateway('{}');
      await gateway.chat({
        taskType: 'classify_intent',
        messages: [{ role: 'user', content: 'hello' }],
        modelOverride: 'gpt-4o',
      });
      expect(provider.getCalls()[0].model).toBe('gpt-4o');
    });

    it('should use default model for unknown taskType', async () => {
      const { gateway, provider } = createMockLLMGateway('{}');
      await gateway.chat({
        taskType: 'unknown_task_xyz',
        messages: [{ role: 'user', content: 'hello' }],
      });
      // Should not throw, uses defaultModel
      expect(provider.getCalls()).toHaveLength(1);
    });

    it('should throw on non-retryable provider error', async () => {
      const { gateway, provider } = createMockLLMGateway('{}');
      jest.spyOn(provider, 'chat').mockRejectedValueOnce(
        Object.assign(new Error('Bad request'), { status: 400 })
      );
      await expect(
        gateway.chat({ taskType: 'classify_intent', messages: [{ role: 'user', content: 'x' }] })
      ).rejects.toThrow('Bad request');
    });
  });

  describe('ask', () => {
    it('should return content string directly', async () => {
      const { gateway } = createMockLLMGateway('hello from AI');
      const result = await gateway.ask('summarize_conversation', 'summarize this');
      expect(result).toBe('hello from AI');
    });
  });
});

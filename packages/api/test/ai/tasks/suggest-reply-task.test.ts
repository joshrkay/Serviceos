import { describe, it, expect } from 'vitest';
import { createMockLLMGateway } from '../../../src/ai/gateway/factory';
import { SuggestReplyTask } from '../../../src/ai/tasks/suggest-reply-task';

describe('SuggestReplyTask', () => {
  it('returns the model draft and sends thread + brand voice in the prompt', async () => {
    const { gateway, provider } = createMockLLMGateway(
      'Hi Sandra — sorry about the AC! We can get a tech out tomorrow; want me to confirm a window?',
    );
    const task = new SuggestReplyTask(gateway);

    const result = await task.suggest({
      messages: [
        { senderRole: 'customer', content: 'My AC stopped cooling last night.' },
        { senderRole: 'owner', content: 'Sorry to hear that — let me check the schedule.' },
        { senderRole: 'customer', content: 'When can someone come out?' },
      ],
      brandVoice: { formality: 'casual', pronoun: 'we', vibe_words: ['neighborly'] },
      businessName: 'Rivera HVAC',
    });

    expect(result.draft).toContain('Sandra');

    const calls = provider.getCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].taskType).toBe('suggest_reply');
    const system = calls[0].messages.find((m) => m.role === 'system')!.content;
    const user = calls[0].messages.find((m) => m.role === 'user')!.content;
    // Brand voice surfaces in the system prompt.
    expect(system).toContain('Rivera HVAC');
    expect(system).toContain('neighborly');
    // The customer/shop transcript is handed to the model.
    expect(user).toContain('Customer: My AC stopped cooling last night.');
    expect(user).toContain('Shop: Sorry to hear that');
  });

  it('passes the tenantId to the gateway for correct AI-run logging/quota', async () => {
    const { gateway, provider } = createMockLLMGateway('draft');
    const task = new SuggestReplyTask(gateway);
    await task.suggest({
      messages: [{ senderRole: 'customer', content: 'Hi' }],
      tenantId: 'tenant-abc',
    });
    expect(provider.getCalls()[0].tenantId).toBe('tenant-abc');
  });

  it('strips wrapping quotes the model sometimes adds', async () => {
    const { gateway } = createMockLLMGateway('"We can be there Thursday at 9am."');
    const task = new SuggestReplyTask(gateway);
    const result = await task.suggest({
      messages: [{ senderRole: 'customer', content: 'What times work?' }],
    });
    expect(result.draft).toBe('We can be there Thursday at 9am.');
  });

  it('throws when there is no thread content to reply to', async () => {
    const { gateway } = createMockLLMGateway('unused');
    const task = new SuggestReplyTask(gateway);
    await expect(
      task.suggest({ messages: [{ senderRole: 'customer', content: '   ' }] }),
    ).rejects.toThrow(/no conversation content/i);
  });

  it('throws when the model returns an empty draft', async () => {
    const { gateway } = createMockLLMGateway('   ');
    const task = new SuggestReplyTask(gateway);
    await expect(
      task.suggest({ messages: [{ senderRole: 'customer', content: 'Hello?' }] }),
    ).rejects.toThrow(/empty draft/i);
  });

  it('defaults the pronoun to "we" and falls back to a neutral business name', async () => {
    const { gateway, provider } = createMockLLMGateway('draft');
    const task = new SuggestReplyTask(gateway);
    await task.suggest({ messages: [{ senderRole: 'customer', content: 'Hi' }] });
    const system = provider.getCalls()[0].messages[0].content;
    expect(system).toContain('the business');
    expect(system).toContain('"we"');
  });
});

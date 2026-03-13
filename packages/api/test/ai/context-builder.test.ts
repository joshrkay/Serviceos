import {
  buildSourceContext,
  estimateContextSize,
  trimContext,
  MAX_CONTEXT_TOKENS,
} from '../../src/ai/orchestration/context-builder';
import type {
  SourceContext,
  EntityRefs,
  ContextRepositories,
} from '../../src/ai/orchestration/context-builder';
import type { Message } from '../../src/conversations/conversation-service';

function makeMessage(index: number, conversationId: string = 'conv-1'): Message {
  return {
    id: `msg-${index}`,
    tenantId: 'tenant-1',
    conversationId,
    messageType: 'text',
    content: `Message content ${index}`,
    senderId: `user-${index % 3}`,
    senderRole: index % 2 === 0 ? 'customer' : 'agent',
    createdAt: new Date(Date.now() - (100 - index) * 60000),
  };
}

function makeRepos(overrides: Partial<ContextRepositories> = {}): ContextRepositories {
  return {
    getConversationMessages: async () => [makeMessage(1), makeMessage(2), makeMessage(3)],
    getCustomer: async () => ({ id: 'cust-1', name: 'Jane Doe', email: 'jane@example.com' }),
    getJob: async () => ({ id: 'job-1', type: 'plumbing', status: 'scheduled' }),
    getLocation: async () => ({ id: 'loc-1', address: '123 Main St' }),
    getTenantInfo: async () => ({ name: 'Acme Services', settings: { timezone: 'US/Eastern' } }),
    ...overrides,
  };
}

describe('P2-008 — Source-context packaging', () => {
  it('happy path — builds context with conversation and entities', async () => {
    const repos = makeRepos();
    const entityRefs: EntityRefs = {
      customerId: 'cust-1',
      jobId: 'job-1',
      locationId: 'loc-1',
    };

    const context = await buildSourceContext('tenant-1', 'conv-1', entityRefs, repos);

    expect(context.conversation).toBeDefined();
    expect(context.conversation!.id).toBe('conv-1');
    expect(context.conversation!.recentMessages).toHaveLength(3);
    expect(context.customer).toEqual({ id: 'cust-1', name: 'Jane Doe', email: 'jane@example.com' });
    expect(context.job).toEqual({ id: 'job-1', type: 'plumbing', status: 'scheduled' });
    expect(context.location).toEqual({ id: 'loc-1', address: '123 Main St' });
    expect(context.tenant).toEqual({ name: 'Acme Services', settings: { timezone: 'US/Eastern' } });
  });

  it('happy path — limits messages to recent 20', async () => {
    const messages: Message[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push(makeMessage(i));
    }

    const repos = makeRepos({
      getConversationMessages: async () => messages,
    });

    const context = await buildSourceContext('tenant-1', 'conv-1', {}, repos);

    expect(context.conversation).toBeDefined();
    expect(context.conversation!.recentMessages).toHaveLength(20);
    // Should keep the most recent 20 (indices 10-29)
    expect(context.conversation!.recentMessages[0].content).toBe('Message content 10');
    expect(context.conversation!.recentMessages[19].content).toBe('Message content 29');
  });

  it('happy path — handles missing optional repos', async () => {
    const repos: ContextRepositories = {};

    const context = await buildSourceContext('tenant-1', 'conv-1', {
      customerId: 'cust-1',
      jobId: 'job-1',
    }, repos);

    expect(context.conversation).toBeUndefined();
    expect(context.customer).toBeUndefined();
    expect(context.job).toBeUndefined();
    expect(context.location).toBeUndefined();
    expect(context.tenant).toBeUndefined();
  });

  it('happy path — handles null entity lookups', async () => {
    const repos = makeRepos({
      getCustomer: async () => null,
      getJob: async () => null,
      getLocation: async () => null,
      getTenantInfo: async () => null,
    });

    const context = await buildSourceContext('tenant-1', 'conv-1', {
      customerId: 'cust-1',
      jobId: 'job-1',
      locationId: 'loc-1',
    }, repos);

    expect(context.conversation).toBeDefined();
    expect(context.customer).toBeUndefined();
    expect(context.job).toBeUndefined();
    expect(context.location).toBeUndefined();
    expect(context.tenant).toBeUndefined();
  });

  it('validation — trims context when exceeding max tokens', () => {
    const largeMessages: Array<{ role: string; content: string; createdAt: Date }> = [];
    for (let i = 0; i < 20; i++) {
      largeMessages.push({
        role: 'customer',
        content: 'x'.repeat(2000),
        createdAt: new Date(),
      });
    }

    const context: SourceContext = {
      conversation: {
        id: 'conv-1',
        recentMessages: largeMessages,
      },
      customer: { id: 'cust-1', name: 'Jane' },
      job: { id: 'job-1', status: 'open' },
      location: { id: 'loc-1', address: '123 Main St' },
    };

    expect(estimateContextSize(context)).toBeGreaterThan(MAX_CONTEXT_TOKENS);

    const trimmed = trimContext(context, MAX_CONTEXT_TOKENS);
    expect(estimateContextSize(trimmed)).toBeLessThanOrEqual(MAX_CONTEXT_TOKENS);
  });

  it('mock provider test — context includes tenant info', async () => {
    const repos = makeRepos({
      getTenantInfo: async () => ({
        name: 'Premium Corp',
        settings: { plan: 'enterprise', maxUsers: 100 },
      }),
    });

    const context = await buildSourceContext('tenant-1', undefined, {}, repos);

    expect(context.tenant).toBeDefined();
    expect(context.tenant!.name).toBe('Premium Corp');
    expect(context.tenant!.settings).toEqual({ plan: 'enterprise', maxUsers: 100 });
    expect(context.conversation).toBeUndefined();
  });

  it('malformed AI output handled gracefully — empty context returns valid object', async () => {
    const repos: ContextRepositories = {};

    const context = await buildSourceContext('tenant-1', undefined, {}, repos);

    expect(context).toBeDefined();
    expect(typeof context).toBe('object');
    expect(estimateContextSize(context)).toBeGreaterThan(0);

    const trimmed = trimContext(context, MAX_CONTEXT_TOKENS);
    expect(trimmed).toBeDefined();
    expect(typeof trimmed).toBe('object');
  });
});

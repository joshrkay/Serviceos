import { describe, it, expect, vi } from 'vitest';
import {
  getOrCreateCustomerConversation,
  isUniqueViolation,
  InMemoryConversationRepository,
  type Conversation,
  type ConversationRepository,
} from '../../src/conversations/conversation-service';

const TENANT = 'tenant-1';
const CUSTOMER = 'cust-1';
const input = { tenantId: TENANT, customerId: CUSTOMER, createdBy: 'user-1', actorRole: 'owner' };

describe('isUniqueViolation', () => {
  it('is true only for SQLSTATE 23505', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
    expect(isUniqueViolation({ code: '23503' })).toBe(false);
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });
});

describe('getOrCreateCustomerConversation', () => {
  it('creates a thread when none exists', async () => {
    const repo = new InMemoryConversationRepository();
    const { conversation, created } = await getOrCreateCustomerConversation(repo, input);
    expect(created).toBe(true);
    expect(conversation.entityId).toBe(CUSTOMER);
  });

  it('returns the existing active thread without creating a duplicate', async () => {
    const repo = new InMemoryConversationRepository();
    const first = await getOrCreateCustomerConversation(repo, input);
    const second = await getOrCreateCustomerConversation(repo, input);
    expect(second.created).toBe(false);
    expect(second.conversation.id).toBe(first.conversation.id);
  });

  it('recovers from a lost race: a 23505 on insert re-reads and returns the winner', async () => {
    // Simulate the partial-unique-index rejection: findByEntity sees nothing
    // (both racers read empty), then our insert loses to the concurrent winner.
    const winner: Conversation = {
      id: 'winner-conv',
      tenantId: TENANT,
      entityType: 'customer',
      entityId: CUSTOMER,
      status: 'open',
      createdBy: 'other-user',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    let findCalls = 0;
    const repo: Pick<ConversationRepository, 'findByEntity' | 'createConversation'> = {
      findByEntity: vi.fn(async () => {
        findCalls += 1;
        // First read (pre-insert) sees nothing; the post-conflict re-read sees
        // the winner the concurrent request committed.
        return findCalls === 1 ? [] : [winner];
      }),
      createConversation: vi.fn(async () => {
        const err = new Error('duplicate key value violates unique constraint') as Error & {
          code: string;
        };
        err.code = '23505';
        throw err;
      }),
    };

    const result = await getOrCreateCustomerConversation(
      repo as ConversationRepository,
      input,
    );
    expect(result.created).toBe(false);
    expect(result.conversation.id).toBe('winner-conv');
    expect(repo.findByEntity).toHaveBeenCalledTimes(2); // initial + post-conflict re-read
  });

  it('rethrows a non-unique-violation insert error', async () => {
    const repo: Pick<ConversationRepository, 'findByEntity' | 'createConversation'> = {
      findByEntity: vi.fn(async () => []),
      createConversation: vi.fn(async () => {
        throw new Error('connection reset');
      }),
    };
    await expect(
      getOrCreateCustomerConversation(repo as ConversationRepository, input),
    ).rejects.toThrow('connection reset');
  });
});

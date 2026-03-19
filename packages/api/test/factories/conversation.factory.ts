import { faker } from './faker';
import {
  Conversation,
  ConversationStatus,
  Message,
  MessageType,
  CreateConversationInput,
  CreateMessageInput,
} from '../../src/conversations/conversation-service';

export function buildConversation(overrides?: Partial<Conversation>): Conversation {
  return {
    id: faker.string.uuid(),
    tenantId: faker.string.uuid(),
    title: faker.lorem.sentence({ min: 3, max: 6 }),
    entityType: 'job',
    entityId: faker.string.uuid(),
    status: 'open' as ConversationStatus,
    createdBy: faker.string.uuid(),
    createdAt: faker.date.recent(),
    updatedAt: faker.date.recent(),
    ...overrides,
  };
}

export function buildMessage(overrides?: Partial<Message>): Message {
  return {
    id: faker.string.uuid(),
    tenantId: faker.string.uuid(),
    conversationId: faker.string.uuid(),
    messageType: 'text' as MessageType,
    content: faker.lorem.paragraph(),
    senderId: faker.string.uuid(),
    senderRole: 'dispatcher',
    createdAt: faker.date.recent(),
    ...overrides,
  };
}

export function buildCreateConversationInput(overrides?: Partial<CreateConversationInput>): CreateConversationInput {
  return {
    tenantId: faker.string.uuid(),
    title: faker.lorem.sentence({ min: 3, max: 6 }),
    createdBy: faker.string.uuid(),
    ...overrides,
  };
}

export function buildCreateMessageInput(overrides?: Partial<CreateMessageInput>): CreateMessageInput {
  return {
    tenantId: faker.string.uuid(),
    conversationId: faker.string.uuid(),
    messageType: 'text',
    content: faker.lorem.paragraph(),
    senderId: faker.string.uuid(),
    senderRole: 'dispatcher',
    ...overrides,
  };
}

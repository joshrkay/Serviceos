import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { PgBaseRepository } from '../db/pg-base';
import {
  Conversation,
  ConversationRepository,
  CreateConversationInput,
  CreateMessageInput,
  Message,
} from './conversation-service';

function mapConversationRow(row: Record<string, unknown>): Conversation {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    title: row.title as string | undefined,
    entityType: row.entity_type as string | undefined,
    entityId: row.entity_id as string | undefined,
    status: row.status as Conversation['status'],
    createdBy: row.created_by as string,
    assignedUserIds: undefined,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function mapMessageRow(row: Record<string, unknown>): Message {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    conversationId: row.conversation_id as string,
    messageType: row.message_type as Message['messageType'],
    content: row.content as string | undefined,
    senderId: row.sender_id as string,
    senderRole: row.sender_role as string,
    fileId: row.file_id as string | undefined,
    source: row.source as string | undefined,
    metadata: row.metadata as Record<string, unknown> | undefined,
    createdAt: new Date(row.created_at as string),
  };
}

export class PgConversationRepository extends PgBaseRepository implements ConversationRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async createConversation(input: CreateConversationInput): Promise<Conversation> {
    const id = uuidv4();
    const now = new Date();
    return this.withTenant(input.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO conversations (id, tenant_id, title, entity_type, entity_id, status, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [id, input.tenantId, input.title ?? null, input.entityType ?? null, input.entityId ?? null, 'open', input.createdBy, now, now]
      );
      return mapConversationRow(result.rows[0]);
    });
  }

  async findById(tenantId: string, id: string): Promise<Conversation | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM conversations WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId]
      );
      if (result.rows.length === 0) return null;
      return mapConversationRow(result.rows[0]);
    });
  }

  async findByEntity(tenantId: string, entityType: string, entityId: string): Promise<Conversation[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM conversations WHERE tenant_id = $1 AND entity_type = $2 AND entity_id = $3 ORDER BY created_at DESC`,
        [tenantId, entityType, entityId]
      );
      return result.rows.map(mapConversationRow);
    });
  }

  async addMessage(input: CreateMessageInput): Promise<Message> {
    const id = uuidv4();
    const now = new Date();
    return this.withTenant(input.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO messages (id, tenant_id, conversation_id, message_type, content, sender_id, sender_role, file_id, source, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          id,
          input.tenantId,
          input.conversationId,
          input.messageType,
          input.content ?? null,
          input.senderId,
          input.senderRole,
          input.fileId ?? null,
          input.source ?? null,
          input.metadata ? JSON.stringify(input.metadata) : null,
          now,
        ]
      );
      return mapMessageRow(result.rows[0]);
    });
  }

  async getMessages(tenantId: string, conversationId: string): Promise<Message[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM messages WHERE tenant_id = $1 AND conversation_id = $2 ORDER BY created_at ASC`,
        [tenantId, conversationId]
      );
      return result.rows.map(mapMessageRow);
    });
  }

  async updateMessageMetadata(
    tenantId: string,
    messageId: string,
    metadata: Record<string, unknown>
  ): Promise<Message | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE messages
         SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
         WHERE id = $2 AND tenant_id = $3
         RETURNING *`,
        [JSON.stringify(metadata), messageId, tenantId]
      );
      if (result.rows.length === 0) return null;
      return mapMessageRow(result.rows[0]);
    });
  }
}

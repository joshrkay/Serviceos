import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { PgBaseRepository } from '../db/pg-base';
import {
  Conversation,
  ConversationRepository,
  CreateConversationInput,
  CreateMessageInput,
  INBOX_ENTITY_TYPES,
  InboxThreadSummary,
  ListInboxThreadsOptions,
  Message,
  MessageSearchHit,
  MessageSearchParams,
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

  // Story 3.11 follow-up (U9) — atomically insert the conversation + its first
  // messages in ONE transaction so a failed message insert rolls back the
  // conversation too (no orphaned empty thread). Mirrors the column lists of
  // createConversation/addMessage.
  async createConversationWithMessages(
    conversation: CreateConversationInput,
    messages: Array<Omit<CreateMessageInput, 'conversationId'>>,
  ): Promise<{ conversation: Conversation; messages: Message[] }> {
    const convId = uuidv4();
    const now = new Date();
    return this.withTenantTransaction(conversation.tenantId, async (client) => {
      const convResult = await client.query(
        `INSERT INTO conversations (id, tenant_id, title, entity_type, entity_id, status, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          convId,
          conversation.tenantId,
          conversation.title ?? null,
          conversation.entityType ?? null,
          conversation.entityId ?? null,
          'open',
          conversation.createdBy,
          now,
          now,
        ]
      );
      const created = mapConversationRow(convResult.rows[0]);
      const out: Message[] = [];
      for (const m of messages) {
        const msgResult = await client.query(
          `INSERT INTO messages (id, tenant_id, conversation_id, message_type, content, sender_id, sender_role, file_id, source, metadata, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING *`,
          [
            uuidv4(),
            m.tenantId,
            convId,
            m.messageType,
            m.content ?? null,
            m.senderId,
            m.senderRole,
            m.fileId ?? null,
            m.source ?? null,
            m.metadata ? JSON.stringify(m.metadata) : null,
            new Date(),
          ]
        );
        out.push(mapMessageRow(msgResult.rows[0]));
      }
      return { conversation: created, messages: out };
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

  async searchMessages(
    tenantId: string,
    params: MessageSearchParams,
  ): Promise<MessageSearchHit[]> {
    const limit = params.limit ?? 50;
    return this.withTenant(tenantId, async (client) => {
      // tenant_id is the first predicate (defense-in-depth alongside RLS).
      // Optional content ILIKE (text) and linked-entity filters are appended
      // positionally so the parameterized query stays injection-safe.
      const sqlParams: unknown[] = [tenantId];
      let textClause = '';
      if (params.text && params.text.trim().length > 0) {
        sqlParams.push(`%${params.text.trim()}%`);
        textClause = `AND m.content ILIKE $${sqlParams.length}`;
      }
      let entityTypeClause = '';
      if (params.entityType) {
        sqlParams.push(params.entityType);
        entityTypeClause = `AND c.entity_type = $${sqlParams.length}`;
      }
      let entityIdClause = '';
      if (params.entityId) {
        sqlParams.push(params.entityId);
        entityIdClause = `AND c.entity_id = $${sqlParams.length}`;
      }
      sqlParams.push(limit);
      const limitParam = `$${sqlParams.length}`;

      const sql = `
        SELECT
          m.*,
          c.title AS conv_title,
          c.entity_type AS conv_entity_type,
          c.entity_id AS conv_entity_id
        FROM messages m
        JOIN conversations c
          ON c.id = m.conversation_id AND c.tenant_id = m.tenant_id
        WHERE m.tenant_id = $1
          ${textClause}
          ${entityTypeClause}
          ${entityIdClause}
        ORDER BY m.created_at DESC
        LIMIT ${limitParam}
      `;
      const { rows } = await client.query(sql, sqlParams);
      return rows.map((row) => ({
        message: mapMessageRow(row),
        conversation: {
          id: row.conversation_id as string,
          title: row.conv_title as string | undefined,
          entityType: row.conv_entity_type as string | undefined,
          entityId: row.conv_entity_id as string | undefined,
        },
      }));
    });
  }

  async listInboxThreads(
    tenantId: string,
    options: ListInboxThreadsOptions = {},
  ): Promise<InboxThreadSummary[]> {
    const limit = options.limit ?? 50;
    return this.withTenant(tenantId, async (client) => {
      // $1 tenant, $2 entity-type allow-list; status/limit appended in order.
      const params: unknown[] = [tenantId, [...INBOX_ENTITY_TYPES]];
      let statusClause = '';
      if (options.status) {
        params.push(options.status);
        statusClause = `AND c.status = $${params.length}`;
      }
      params.push(limit);
      const limitParam = `$${params.length}`;

      // One row per comms thread, summarised by its newest message (LATERAL
      // top-1) plus a message count. `customers` is joined only for 'customer'
      // threads; the id↔entity_id compare is on text so non-UUID unmatched
      // entity_ids (E.164 phones) never hit a uuid cast. Newest-message
      // direction (explicit metadata, else sender_role) drives needs-reply
      // ordering so unanswered customer texts float to the top.
      const sql = `
        SELECT * FROM (
          SELECT
            c.id, c.tenant_id, c.title, c.entity_type, c.entity_id, c.status,
            c.created_by, c.created_at, c.updated_at,
            lm.content AS last_content,
            lm.created_at AS last_created_at,
            mc.message_count,
            -- Display name for the thread's contact: customers by display_name,
            -- leads by their name (else company). Compared on text so non-UUID
            -- unmatched entity_ids (E.164 phones) never hit a uuid cast.
            COALESCE(
              cust.display_name,
              NULLIF(TRIM(COALESCE(ld.first_name, '') || ' ' || COALESCE(ld.last_name, '')), ''),
              ld.company_name
            ) AS customer_name,
            COALESCE(
              lm.metadata->>'direction',
              CASE WHEN lm.sender_role = 'customer' THEN 'inbound' ELSE 'outbound' END
            ) AS last_direction
          FROM conversations c
          JOIN LATERAL (
            SELECT m.content, m.created_at, m.sender_role, m.metadata
            FROM messages m
            WHERE m.tenant_id = c.tenant_id AND m.conversation_id = c.id
            ORDER BY m.created_at DESC
            LIMIT 1
          ) lm ON true
          JOIN LATERAL (
            SELECT count(*)::int AS message_count
            FROM messages m2
            WHERE m2.tenant_id = c.tenant_id AND m2.conversation_id = c.id
          ) mc ON true
          LEFT JOIN customers cust
            ON cust.tenant_id = c.tenant_id
            AND c.entity_type = 'customer'
            AND cust.id::text = c.entity_id
          LEFT JOIN leads ld
            ON ld.tenant_id = c.tenant_id
            AND c.entity_type = 'lead'
            AND ld.id::text = c.entity_id
          WHERE c.tenant_id = $1
            AND c.entity_type = ANY($2)
            ${statusClause}
        ) t
        ${options.needsReplyOnly ? `WHERE t.last_direction = 'inbound'` : ''}
        ORDER BY (t.last_direction = 'inbound') DESC, t.last_created_at DESC
        LIMIT ${limitParam}
      `;
      const { rows } = await client.query(sql, params);
      return rows.map(mapInboxRow);
    });
  }
}

function mapInboxRow(row: Record<string, unknown>): InboxThreadSummary {
  const direction = row.last_direction === 'inbound' ? 'inbound' : 'outbound';
  return {
    conversation: mapConversationRow(row),
    lastMessageAt: new Date(row.last_created_at as string).toISOString(),
    lastMessagePreview: ((row.last_content as string | null) ?? '').slice(0, 160),
    lastMessageDirection: direction,
    needsReply: direction === 'inbound',
    messageCount: Number(row.message_count),
    ...(row.customer_name ? { customerName: row.customer_name as string } : {}),
  };
}

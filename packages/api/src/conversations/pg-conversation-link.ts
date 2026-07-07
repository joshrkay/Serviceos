/**
 * P0-037 — Postgres implementation of the ConversationLinkRepository port
 * (linkage.ts), backed by the conversation_links table (migration 233).
 *
 * create() is idempotent on (tenant_id, conversation_id, entity_type,
 * entity_id): a retried threading pass (e.g. the dropped-call recovery
 * threader re-running after a partial failure) re-links without duplicating.
 * On conflict the existing row is returned so callers always get the
 * canonical link.
 */
import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import type {
  ConversationLink,
  ConversationLinkRepository,
  LinkableEntityType,
} from './linkage';

interface LinkRow {
  id: string;
  tenant_id: string;
  conversation_id: string;
  entity_type: LinkableEntityType;
  entity_id: string;
  created_at: Date | string;
}

function mapRow(row: LinkRow): ConversationLink {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    conversationId: row.conversation_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    createdAt: new Date(row.created_at),
  };
}

const LINK_COLUMNS = 'id, tenant_id, conversation_id, entity_type, entity_id, created_at';

export class PgConversationLinkRepository
  extends PgBaseRepository
  implements ConversationLinkRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async create(link: ConversationLink): Promise<ConversationLink> {
    return this.withTenant(link.tenantId, async (client) => {
      // tenant_id comes from the RLS GUC so it can never diverge from the
      // tenant context that gates the row (same pattern as
      // PgDroppedCallRecoveryRepository.schedule).
      const { rows } = await client.query<LinkRow>(
        `INSERT INTO conversation_links
           (id, tenant_id, conversation_id, entity_type, entity_id)
         VALUES ($1, current_setting('app.current_tenant_id')::uuid, $2, $3, $4)
         ON CONFLICT (tenant_id, conversation_id, entity_type, entity_id) DO NOTHING
         RETURNING ${LINK_COLUMNS}`,
        [link.id, link.conversationId, link.entityType, link.entityId],
      );
      if (rows[0]) return mapRow(rows[0]);
      // Conflict — the link already exists; return the canonical row.
      const existing = await client.query<LinkRow>(
        `SELECT ${LINK_COLUMNS}
           FROM conversation_links
          WHERE tenant_id = current_setting('app.current_tenant_id')::uuid
            AND conversation_id = $1 AND entity_type = $2 AND entity_id = $3`,
        [link.conversationId, link.entityType, link.entityId],
      );
      return mapRow(existing.rows[0]);
    });
  }

  async findByConversation(
    tenantId: string,
    conversationId: string,
  ): Promise<ConversationLink[]> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query<LinkRow>(
        `SELECT ${LINK_COLUMNS}
           FROM conversation_links
          WHERE tenant_id = current_setting('app.current_tenant_id')::uuid
            AND conversation_id = $1
          ORDER BY created_at ASC`,
        [conversationId],
      );
      return rows.map(mapRow);
    });
  }

  async findByEntity(
    tenantId: string,
    entityType: LinkableEntityType,
    entityId: string,
  ): Promise<ConversationLink[]> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query<LinkRow>(
        `SELECT ${LINK_COLUMNS}
           FROM conversation_links
          WHERE tenant_id = current_setting('app.current_tenant_id')::uuid
            AND entity_type = $1 AND entity_id = $2
          ORDER BY created_at ASC`,
        [entityType, entityId],
      );
      return rows.map(mapRow);
    });
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `DELETE FROM conversation_links
          WHERE tenant_id = current_setting('app.current_tenant_id')::uuid
            AND id = $1`,
        [id],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }
}

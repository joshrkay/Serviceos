import { Pool } from 'pg';
import { PgBaseRepository } from '../../db/pg-base';
import type { ProposalSmsDirection } from '@ai-service-os/shared';

export interface ProposalSmsEventRow {
  id: string;
  tenantId: string;
  proposalId: string;
  direction: ProposalSmsDirection;
  messageSid: string;
  ownerE164: string;
  bodyPreview: string;
  inboundAction?: string | null;
  createdAt: Date;
}

export interface RecordProposalSmsEventInput {
  tenantId: string;
  proposalId: string;
  direction: ProposalSmsDirection;
  messageSid: string;
  ownerE164: string;
  bodyPreview: string;
  inboundAction?: string;
}

export interface ProposalSmsEditSession {
  tenantId: string;
  proposalId: string;
  ownerUserId: string;
  openedAt: Date;
  expiresAt: Date;
}

export interface ProposalSmsEventRepository {
  /** Returns false when messageSid already exists (idempotent no-op). */
  recordEvent(input: RecordProposalSmsEventInput): Promise<boolean>;
  findByMessageSid(messageSid: string): Promise<ProposalSmsEventRow | null>;
  findLatestOutboundForPhone(
    tenantId: string,
    ownerE164: string,
  ): Promise<ProposalSmsEventRow | null>;
  openEditSession(
    tenantId: string,
    proposalId: string,
    ownerUserId: string,
    expiresAt: Date,
  ): Promise<void>;
  findActiveEditSession(
    tenantId: string,
    ownerUserId: string,
    now?: Date,
  ): Promise<ProposalSmsEditSession | null>;
  clearEditSession(tenantId: string, ownerUserId: string): Promise<void>;
}

function previewBody(body: string, max = 160): string {
  const trimmed = body.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

export class InMemoryProposalSmsEventRepository implements ProposalSmsEventRepository {
  private events: ProposalSmsEventRow[] = [];
  private sessions = new Map<string, ProposalSmsEditSession>();

  private sessionKey(tenantId: string, ownerUserId: string): string {
    return `${tenantId}::${ownerUserId}`;
  }

  async recordEvent(input: RecordProposalSmsEventInput): Promise<boolean> {
    if (this.events.some((e) => e.messageSid === input.messageSid)) {
      return false;
    }
    this.events.push({
      id: `pse-${this.events.length + 1}`,
      tenantId: input.tenantId,
      proposalId: input.proposalId,
      direction: input.direction,
      messageSid: input.messageSid,
      ownerE164: input.ownerE164,
      bodyPreview: previewBody(input.bodyPreview),
      inboundAction: input.inboundAction ?? null,
      createdAt: new Date(),
    });
    return true;
  }

  async findByMessageSid(messageSid: string): Promise<ProposalSmsEventRow | null> {
    return this.events.find((e) => e.messageSid === messageSid) ?? null;
  }

  async findLatestOutboundForPhone(
    tenantId: string,
    ownerE164: string,
  ): Promise<ProposalSmsEventRow | null> {
    const matches = this.events
      .filter(
        (e) =>
          e.tenantId === tenantId &&
          e.ownerE164 === ownerE164 &&
          e.direction === 'outbound',
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return matches[0] ?? null;
  }

  async openEditSession(
    tenantId: string,
    proposalId: string,
    ownerUserId: string,
    expiresAt: Date,
  ): Promise<void> {
    this.sessions.set(this.sessionKey(tenantId, ownerUserId), {
      tenantId,
      proposalId,
      ownerUserId,
      openedAt: new Date(),
      expiresAt,
    });
  }

  async findActiveEditSession(
    tenantId: string,
    ownerUserId: string,
    now: Date = new Date(),
  ): Promise<ProposalSmsEditSession | null> {
    const session = this.sessions.get(this.sessionKey(tenantId, ownerUserId));
    if (!session || session.expiresAt.getTime() <= now.getTime()) {
      return null;
    }
    return session;
  }

  async clearEditSession(tenantId: string, ownerUserId: string): Promise<void> {
    this.sessions.delete(this.sessionKey(tenantId, ownerUserId));
  }
}

export class PgProposalSmsEventRepository
  extends PgBaseRepository
  implements ProposalSmsEventRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async recordEvent(input: RecordProposalSmsEventInput): Promise<boolean> {
    return this.withTenant(input.tenantId, async (client) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO proposal_approval_sms_events (
           tenant_id, proposal_id, direction, message_sid, owner_e164, body_preview, inbound_action
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (message_sid) DO NOTHING
         RETURNING id`,
        [
          input.tenantId,
          input.proposalId,
          input.direction,
          input.messageSid,
          input.ownerE164,
          previewBody(input.bodyPreview),
          input.inboundAction ?? null,
        ],
      );
      return result.rowCount === 1;
    });
  }

  async findByMessageSid(messageSid: string): Promise<ProposalSmsEventRow | null> {
    const result = await this.pool.query(
      `SELECT id, tenant_id, proposal_id, direction, message_sid, owner_e164,
              body_preview, inbound_action, created_at
       FROM proposal_approval_sms_events
       WHERE message_sid = $1
       LIMIT 1`,
      [messageSid],
    );
    const row = result.rows[0];
    if (!row) return null;
    return mapRow(row);
  }

  async findLatestOutboundForPhone(
    tenantId: string,
    ownerE164: string,
  ): Promise<ProposalSmsEventRow | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT id, tenant_id, proposal_id, direction, message_sid, owner_e164,
                body_preview, inbound_action, created_at
         FROM proposal_approval_sms_events
         WHERE tenant_id = $1 AND owner_e164 = $2 AND direction = 'outbound'
         ORDER BY created_at DESC
         LIMIT 1`,
        [tenantId, ownerE164],
      );
      const row = result.rows[0];
      return row ? mapRow(row) : null;
    });
  }

  async openEditSession(
    tenantId: string,
    proposalId: string,
    ownerUserId: string,
    expiresAt: Date,
  ): Promise<void> {
    await this.withTenant(tenantId, async (client) => {
      await client.query(
        `INSERT INTO proposal_sms_edit_sessions (
           tenant_id, proposal_id, owner_user_id, opened_at, expires_at
         ) VALUES ($1, $2, $3, now(), $4)
         ON CONFLICT (tenant_id, owner_user_id)
         DO UPDATE SET proposal_id = EXCLUDED.proposal_id,
                       opened_at = now(),
                       expires_at = EXCLUDED.expires_at`,
        [tenantId, proposalId, ownerUserId, expiresAt],
      );
    });
  }

  async findActiveEditSession(
    tenantId: string,
    ownerUserId: string,
    now: Date = new Date(),
  ): Promise<ProposalSmsEditSession | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT tenant_id, proposal_id, owner_user_id, opened_at, expires_at
         FROM proposal_sms_edit_sessions
         WHERE tenant_id = $1 AND owner_user_id = $2 AND expires_at > $3
         LIMIT 1`,
        [tenantId, ownerUserId, now],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        tenantId: row.tenant_id,
        proposalId: row.proposal_id,
        ownerUserId: row.owner_user_id,
        openedAt: row.opened_at,
        expiresAt: row.expires_at,
      };
    });
  }

  async clearEditSession(tenantId: string, ownerUserId: string): Promise<void> {
    await this.withTenant(tenantId, async (client) => {
      await client.query(
        `DELETE FROM proposal_sms_edit_sessions
         WHERE tenant_id = $1 AND owner_user_id = $2`,
        [tenantId, ownerUserId],
      );
    });
  }
}

function mapRow(row: Record<string, unknown>): ProposalSmsEventRow {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    proposalId: String(row.proposal_id),
    direction: row.direction as ProposalSmsDirection,
    messageSid: String(row.message_sid),
    ownerE164: String(row.owner_e164),
    bodyPreview: String(row.body_preview),
    inboundAction: row.inbound_action ? String(row.inbound_action) : null,
    createdAt: row.created_at as Date,
  };
}

/**
 * P2-034 — proposal SMS event store (migration 156: `proposal_sms_events`).
 *
 * Append-only record of the SMS approval conversation around a proposal:
 *
 *   outbound `proposal_rendered`     — the approval request we texted the owner
 *   outbound `reapproval_rendered`   — re-render after an SMS edit
 *   outbound `clarification_sent`    — the one-time "Reply Y/N/EDIT" nudge
 *   inbound  `reply_approve` / `reply_reject` — the owner's decision
 *   inbound  `edit_session_opened`   — EDIT received; `expiresAt` = +10 min
 *   inbound  `edit_request`          — the free-text change inside the window
 *
 * Two queries drive the inbound handler:
 *   • `findRecentOutbound` — "which proposal is the owner replying to?"
 *     (most recent rendered proposal whose status is still actionable)
 *   • `findOpenEditSession` — "is the owner mid-edit?" An open session is an
 *     `edit_session_opened` row that is neither expired nor consumed. The
 *     window is FIXED from open time — follow-up messages never extend it
 *     (the review prompt's anti-spam requirement).
 */
import { v4 as uuidv4 } from 'uuid';
import { Pool } from 'pg';
import { PgBaseRepository } from '../../db/pg-base';

export type ProposalSmsDirection = 'outbound' | 'inbound';

export type ProposalSmsEventKind =
  | 'proposal_rendered'
  | 'reapproval_rendered'
  | 'clarification_sent'
  | 'reply_approve'
  | 'reply_reject'
  | 'edit_session_opened'
  | 'edit_request';

export interface ProposalSmsEvent {
  id: string;
  tenantId: string;
  proposalId: string;
  direction: ProposalSmsDirection;
  kind: ProposalSmsEventKind;
  /** Twilio MessageSid — inbound always; outbound when the provider returns one. */
  messageSid?: string;
  /**
   * Normalized sender digits (shared/phone normalizePhone), inbound rows
   * only. Scopes edit sessions to the approver who opened them — a tenant
   * can have two approvers (owner + backup supervisor).
   */
  fromPhone?: string;
  body: string;
  /** Only set on `edit_session_opened` rows. */
  expiresAt?: Date;
  /** Set when an edit session is closed (edit received / superseded). */
  consumedAt?: Date;
  createdAt: Date;
}

export interface CreateProposalSmsEventInput {
  tenantId: string;
  proposalId: string;
  direction: ProposalSmsDirection;
  kind: ProposalSmsEventKind;
  messageSid?: string;
  fromPhone?: string;
  body: string;
  expiresAt?: Date;
  now?: Date;
}

export function createProposalSmsEvent(
  input: CreateProposalSmsEventInput,
): ProposalSmsEvent {
  return {
    id: uuidv4(),
    tenantId: input.tenantId,
    proposalId: input.proposalId,
    direction: input.direction,
    kind: input.kind,
    ...(input.messageSid ? { messageSid: input.messageSid } : {}),
    ...(input.fromPhone ? { fromPhone: input.fromPhone } : {}),
    body: input.body,
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    createdAt: input.now ?? new Date(),
  };
}

export interface ProposalSmsEventRepository {
  create(event: ProposalSmsEvent): Promise<ProposalSmsEvent>;
  /**
   * Most recent outbound `proposal_rendered` / `reapproval_rendered`
   * events, newest first. The reply handler walks these and acts on the
   * first one whose proposal is still actionable.
   */
  findRecentOutbound(tenantId: string, limit: number): Promise<ProposalSmsEvent[]>;
  /**
   * The open (unexpired, unconsumed) edit session opened by this sender
   * (normalized digits), if any. Sender-scoped so one approver's session
   * never captures another approver's reply.
   */
  findOpenEditSession(
    tenantId: string,
    fromPhone: string,
    now: Date,
  ): Promise<ProposalSmsEvent | null>;
  /** How many clarification nudges this proposal has already received. */
  countClarifications(tenantId: string, proposalId: string): Promise<number>;
  /** Close an edit session (idempotent). */
  markConsumed(tenantId: string, id: string, at: Date): Promise<void>;
}

export class InMemoryProposalSmsEventRepository
  implements ProposalSmsEventRepository
{
  readonly events: ProposalSmsEvent[] = [];

  async create(event: ProposalSmsEvent): Promise<ProposalSmsEvent> {
    this.events.push({ ...event });
    return event;
  }

  async findRecentOutbound(tenantId: string, limit: number): Promise<ProposalSmsEvent[]> {
    return this.events
      .filter(
        (e) =>
          e.tenantId === tenantId &&
          e.direction === 'outbound' &&
          (e.kind === 'proposal_rendered' || e.kind === 'reapproval_rendered'),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map((e) => ({ ...e }));
  }

  async findOpenEditSession(
    tenantId: string,
    fromPhone: string,
    now: Date,
  ): Promise<ProposalSmsEvent | null> {
    const open = this.events
      .filter(
        (e) =>
          e.tenantId === tenantId &&
          e.kind === 'edit_session_opened' &&
          e.fromPhone === fromPhone &&
          !e.consumedAt &&
          e.expiresAt !== undefined &&
          e.expiresAt.getTime() > now.getTime(),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return open[0] ? { ...open[0] } : null;
  }

  async countClarifications(tenantId: string, proposalId: string): Promise<number> {
    return this.events.filter(
      (e) =>
        e.tenantId === tenantId &&
        e.proposalId === proposalId &&
        e.kind === 'clarification_sent',
    ).length;
  }

  async markConsumed(tenantId: string, id: string, at: Date): Promise<void> {
    const event = this.events.find((e) => e.tenantId === tenantId && e.id === id);
    if (event && !event.consumedAt) event.consumedAt = at;
  }
}

function mapRow(row: Record<string, unknown>): ProposalSmsEvent {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    proposalId: row.proposal_id as string,
    direction: row.direction as ProposalSmsDirection,
    kind: row.kind as ProposalSmsEventKind,
    ...(row.message_sid ? { messageSid: row.message_sid as string } : {}),
    ...(row.from_phone ? { fromPhone: row.from_phone as string } : {}),
    body: row.body as string,
    ...(row.expires_at ? { expiresAt: new Date(row.expires_at as string) } : {}),
    ...(row.consumed_at ? { consumedAt: new Date(row.consumed_at as string) } : {}),
    createdAt: new Date(row.created_at as string),
  };
}

export class PgProposalSmsEventRepository
  extends PgBaseRepository
  implements ProposalSmsEventRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async create(event: ProposalSmsEvent): Promise<ProposalSmsEvent> {
    return this.withTenant(event.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO proposal_sms_events (
           id, tenant_id, proposal_id, direction, kind, message_sid,
           from_phone, body, expires_at, consumed_at, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [
          event.id,
          event.tenantId,
          event.proposalId,
          event.direction,
          event.kind,
          event.messageSid ?? null,
          event.fromPhone ?? null,
          event.body,
          event.expiresAt ?? null,
          event.consumedAt ?? null,
          event.createdAt,
        ],
      );
      return mapRow(result.rows[0] as Record<string, unknown>);
    });
  }

  async findRecentOutbound(tenantId: string, limit: number): Promise<ProposalSmsEvent[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM proposal_sms_events
          WHERE tenant_id = $1
            AND direction = 'outbound'
            AND kind IN ('proposal_rendered', 'reapproval_rendered')
          ORDER BY created_at DESC
          LIMIT $2`,
        [tenantId, limit],
      );
      return (result.rows as Record<string, unknown>[]).map(mapRow);
    });
  }

  async findOpenEditSession(
    tenantId: string,
    fromPhone: string,
    now: Date,
  ): Promise<ProposalSmsEvent | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM proposal_sms_events
          WHERE tenant_id = $1
            AND kind = 'edit_session_opened'
            AND from_phone = $2
            AND consumed_at IS NULL
            AND expires_at > $3
          ORDER BY created_at DESC
          LIMIT 1`,
        [tenantId, fromPhone, now],
      );
      if (result.rows.length === 0) return null;
      return mapRow(result.rows[0] as Record<string, unknown>);
    });
  }

  async countClarifications(tenantId: string, proposalId: string): Promise<number> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT COUNT(*)::int AS count FROM proposal_sms_events
          WHERE tenant_id = $1 AND proposal_id = $2 AND kind = 'clarification_sent'`,
        [tenantId, proposalId],
      );
      return (result.rows[0] as { count: number }).count;
    });
  }

  async markConsumed(tenantId: string, id: string, at: Date): Promise<void> {
    await this.withTenant(tenantId, async (client) => {
      await client.query(
        `UPDATE proposal_sms_events
            SET consumed_at = $3
          WHERE tenant_id = $1 AND id = $2 AND consumed_at IS NULL`,
        [tenantId, id, at],
      );
    });
  }
}

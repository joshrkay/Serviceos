/**
 * P2-034 — proposal SMS event store (migration 156: `proposal_sms_events`).
 *
 * Append-only record of the SMS approval conversation around a proposal:
 *
 *   outbound `proposal_rendered`     — the approval request we texted the owner
 *   outbound `reapproval_rendered`   — re-render after an SMS edit
 *   outbound `review_required_rendered` — RV-074 low/very_low-confidence
 *     send ("needs review in app — reply N to reject"). No approve
 *     affordance, but it IS the owner's latest conversation turn, so it
 *     must anchor reply targeting like any other render.
 *   outbound `voice_reapproval`      — a voice edit was applied and the
 *     updated values were read back BY VOICE only (no SMS re-render was
 *     sent — the SMS deps weren't wired). It clears the pending-edit
 *     block like `reapproval_rendered`, but it is NOT a reply anchor:
 *     the owner never received a text for it, so a texted Y must keep
 *     targeting the latest message we actually SENT (migration 171).
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
  | 'review_required_rendered'
  | 'voice_reapproval'
  | 'clarification_sent'
  | 'reply_approve'
  | 'reply_reject'
  | 'edit_session_opened'
  | 'edit_request';

/**
 * The two outbound kinds that anchor the inbound reply transport — the ones
 * `findRecentOutbound` returns and Y/N/EDIT replies resolve against. Named
 * centrally to eliminate the five inline `'proposal_rendered' |
 * 'review_required_rendered'` unions spread across callers.
 */
export type OutboundAnchorKind = Extract<
  ProposalSmsEventKind,
  'proposal_rendered' | 'review_required_rendered'
>;

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
  /**
   * Monotonic insertion order (DB BIGSERIAL / in-memory counter),
   * assigned by the store. Tiebreaker for same-millisecond `createdAt` —
   * "the latest render" must be deterministic because it decides which
   * proposal a Y/N reply targets.
   */
  seq?: number;
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
   * Most recent outbound `proposal_rendered` / `reapproval_rendered` /
   * `review_required_rendered` events, newest first. The reply handler
   * walks these and acts on the first one whose proposal is still
   * actionable. `voice_reapproval` is deliberately EXCLUDED: no text was
   * sent for it, so it must never retarget the owner's next Y/N reply
   * away from the latest message they actually received.
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
  /**
   * True when the proposal has an `edit_request` not yet followed by a
   * `reapproval_rendered` (SMS re-render) or `voice_reapproval` (spoken
   * re-render) — the owner asked for a change that could not be applied.
   * While true, an SMS `Y` must NOT approve: the owner would be
   * executing the stale payload they were told needs the review queue.
   * Decided by insertion order (`seq`), so same-millisecond pairs
   * resolve correctly: the reapproval is always inserted after.
   */
  hasUnappliedEditRequest(tenantId: string, proposalId: string): Promise<boolean>;
  /** Close an edit session (idempotent). */
  markConsumed(tenantId: string, id: string, at: Date): Promise<void>;
}

function bySeqDesc(a: ProposalSmsEvent, b: ProposalSmsEvent): number {
  const byTime = b.createdAt.getTime() - a.createdAt.getTime();
  if (byTime !== 0) return byTime;
  return (b.seq ?? 0) - (a.seq ?? 0);
}

export class InMemoryProposalSmsEventRepository
  implements ProposalSmsEventRepository
{
  readonly events: ProposalSmsEvent[] = [];
  private nextSeq = 1;

  async create(event: ProposalSmsEvent): Promise<ProposalSmsEvent> {
    const stored = { ...event, seq: this.nextSeq++ };
    this.events.push(stored);
    return { ...stored };
  }

  async findRecentOutbound(tenantId: string, limit: number): Promise<ProposalSmsEvent[]> {
    return this.events
      .filter(
        (e) =>
          e.tenantId === tenantId &&
          e.direction === 'outbound' &&
          (e.kind === 'proposal_rendered' ||
            e.kind === 'reapproval_rendered' ||
            e.kind === 'review_required_rendered'),
      )
      .sort(bySeqDesc)
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
      .sort(bySeqDesc);
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

  async hasUnappliedEditRequest(tenantId: string, proposalId: string): Promise<boolean> {
    const latest = this.events
      .filter(
        (e) =>
          e.tenantId === tenantId &&
          e.proposalId === proposalId &&
          // voice_reapproval clears the block (the owner heard the updated
          // values read back) without becoming a reply anchor — it is
          // deliberately ABSENT from findRecentOutbound above.
          (e.kind === 'edit_request' ||
            e.kind === 'reapproval_rendered' ||
            e.kind === 'voice_reapproval'),
      )
      .sort(bySeqDesc)[0];
    return latest?.kind === 'edit_request';
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
    ...(row.seq != null ? { seq: Number(row.seq) } : {}),
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
            AND kind IN ('proposal_rendered', 'reapproval_rendered', 'review_required_rendered')
          ORDER BY created_at DESC, seq DESC
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
          ORDER BY created_at DESC, seq DESC
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

  async hasUnappliedEditRequest(tenantId: string, proposalId: string): Promise<boolean> {
    return this.withTenant(tenantId, async (client) => {
      // Insertion order decides: the reapproval row is always inserted
      // after the edit_request it answers, so the most recent of the
      // kinds tells whether the latest request was applied. Both the SMS
      // re-render (reapproval_rendered) and the spoken-only re-render
      // (voice_reapproval, migration 171) clear the block; only the
      // former is a reply anchor (see findRecentOutbound).
      const result = await client.query(
        `SELECT kind FROM proposal_sms_events
          WHERE tenant_id = $1 AND proposal_id = $2
            AND kind IN ('edit_request', 'reapproval_rendered', 'voice_reapproval')
          ORDER BY created_at DESC, seq DESC
          LIMIT 1`,
        [tenantId, proposalId],
      );
      return result.rows[0]?.kind === 'edit_request';
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

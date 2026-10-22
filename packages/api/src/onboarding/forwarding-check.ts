/**
 * D-044 / #1766 — the call-forwarding check. "Test it" places a call from the
 * tenant's Rivet number to their business number. If forwarding works the
 * carrier sends that call straight back to the Rivet number; the inbound voice
 * webhook recognises it through the short-lived correlation record created
 * here, marks the check passed, and hangs up without starting an AI
 * conversation.
 *
 * Recognition is "a pending, unexpired check for this tenant whose Rivet number
 * is the caller". The Rivet number is the only caller id that can come back
 * through a forward of the test call, and the record lives for minutes. A
 * spoofed call could at worst tick the check early; it can never reach the AI.
 *
 * Changes made at the carrier afterwards are not detectable and not promised
 * (D-044): a pass says forwarding worked on the date shown.
 */
import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import type { CallForwardingMode } from '@ai-service-os/shared';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { PgBaseRepository } from '../db/pg-base';
import type { TenantTwilioCreds } from '../integrations/credentials';
import { normalizeMobileE164 } from '../shared/phone/normalize';
import { ValidationError } from '../shared/errors';
import type { CallForwardingRepository } from './call-forwarding';

export type ForwardingCheckStatus = 'pending' | 'passed' | 'timed_out' | 'failed';

export type ForwardingCheckFailureReason = 'call_not_placed';

/** How long a check waits for the call to come back. */
export const FORWARDING_CHECK_TTL_MS = 120_000;
/** How long Twilio rings the business number before giving up. */
const RING_TIMEOUT_SECONDS = 45;

export interface ForwardingCheck {
  id: string;
  tenantId: string;
  status: ForwardingCheckStatus;
  mode: CallForwardingMode;
  rivetNumber: string;
  businessNumber: string;
  callSid: string | null;
  failureReason: ForwardingCheckFailureReason | null;
  createdAt: Date;
  expiresAt: Date;
  completedAt: Date | null;
}

export interface ForwardingCheckRepository {
  /** Replaces any earlier pending check for the tenant (one open check at a time). */
  create(check: ForwardingCheck): Promise<void>;
  latest(tenantId: string): Promise<ForwardingCheck | null>;
  findPendingFrom(tenantId: string, rivetNumber: string, now: Date): Promise<ForwardingCheck | null>;
  setCallSid(tenantId: string, id: string, callSid: string): Promise<void>;
  /** Moves a still-pending check to its result; false if it was already settled. */
  settle(
    tenantId: string,
    id: string,
    result: {
      status: Exclude<ForwardingCheckStatus, 'pending'>;
      failureReason?: ForwardingCheckFailureReason;
      at: Date;
    },
  ): Promise<boolean>;
}

export class InMemoryForwardingCheckRepository implements ForwardingCheckRepository {
  private readonly rows: ForwardingCheck[] = [];

  async create(check: ForwardingCheck): Promise<void> {
    for (const row of this.rows) {
      if (row.tenantId === check.tenantId && row.status === 'pending') row.status = 'failed';
    }
    this.rows.push({ ...check });
  }

  async latest(tenantId: string): Promise<ForwardingCheck | null> {
    const mine = this.rows.filter((r) => r.tenantId === tenantId);
    const last = mine[mine.length - 1];
    return last ? { ...last } : null;
  }

  async findPendingFrom(tenantId: string, rivetNumber: string, now: Date) {
    const row = this.rows.find(
      (r) =>
        r.tenantId === tenantId &&
        r.status === 'pending' &&
        r.rivetNumber === rivetNumber &&
        r.expiresAt.getTime() > now.getTime(),
    );
    return row ? { ...row } : null;
  }

  async setCallSid(tenantId: string, id: string, callSid: string): Promise<void> {
    const row = this.rows.find((r) => r.tenantId === tenantId && r.id === id);
    if (row) row.callSid = callSid;
  }

  async settle(
    tenantId: string,
    id: string,
    result: { status: Exclude<ForwardingCheckStatus, 'pending'>; failureReason?: ForwardingCheckFailureReason; at: Date },
  ): Promise<boolean> {
    const row = this.rows.find((r) => r.tenantId === tenantId && r.id === id);
    if (!row || row.status !== 'pending') return false;
    row.status = result.status;
    row.failureReason = result.failureReason ?? null;
    row.completedAt = result.at;
    return true;
  }
}

interface CheckRow {
  id: string;
  tenant_id: string;
  status: ForwardingCheckStatus;
  mode: CallForwardingMode;
  rivet_number: string;
  business_number: string;
  call_sid: string | null;
  failure_reason: ForwardingCheckFailureReason | null;
  created_at: Date;
  expires_at: Date;
  completed_at: Date | null;
}

function toCheck(r: CheckRow): ForwardingCheck {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    status: r.status,
    mode: r.mode,
    rivetNumber: r.rivet_number,
    businessNumber: r.business_number,
    callSid: r.call_sid,
    failureReason: r.failure_reason,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    completedAt: r.completed_at,
  };
}

export class PgForwardingCheckRepository extends PgBaseRepository implements ForwardingCheckRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async create(check: ForwardingCheck): Promise<void> {
    await this.withTenant(check.tenantId, async (client) => {
      await client.query(
        `UPDATE call_forwarding_checks SET status = 'failed', completed_at = $2
          WHERE tenant_id = $1 AND status = 'pending'`,
        [check.tenantId, check.createdAt],
      );
      await client.query(
        `INSERT INTO call_forwarding_checks
           (id, tenant_id, status, mode, rivet_number, business_number, created_at, expires_at)
         VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7)`,
        [
          check.id,
          check.tenantId,
          check.mode,
          check.rivetNumber,
          check.businessNumber,
          check.createdAt,
          check.expiresAt,
        ],
      );
    });
  }

  async latest(tenantId: string): Promise<ForwardingCheck | null> {
    return this.withTenant(tenantId, async (client) => {
      const r = await client.query<CheckRow>(
        `SELECT * FROM call_forwarding_checks WHERE tenant_id = $1
          ORDER BY created_at DESC LIMIT 1`,
        [tenantId],
      );
      return r.rows[0] ? toCheck(r.rows[0]) : null;
    });
  }

  async findPendingFrom(tenantId: string, rivetNumber: string, now: Date) {
    return this.withTenant(tenantId, async (client) => {
      const r = await client.query<CheckRow>(
        `SELECT * FROM call_forwarding_checks
          WHERE tenant_id = $1 AND status = 'pending' AND rivet_number = $2 AND expires_at > $3
          ORDER BY created_at DESC LIMIT 1`,
        [tenantId, rivetNumber, now],
      );
      return r.rows[0] ? toCheck(r.rows[0]) : null;
    });
  }

  async setCallSid(tenantId: string, id: string, callSid: string): Promise<void> {
    await this.withTenant(tenantId, async (client) => {
      await client.query(`UPDATE call_forwarding_checks SET call_sid = $3 WHERE tenant_id = $1 AND id = $2`, [
        tenantId,
        id,
        callSid,
      ]);
    });
  }

  async settle(
    tenantId: string,
    id: string,
    result: { status: Exclude<ForwardingCheckStatus, 'pending'>; failureReason?: ForwardingCheckFailureReason; at: Date },
  ): Promise<boolean> {
    return this.withTenant(tenantId, async (client) => {
      const r = await client.query(
        `UPDATE call_forwarding_checks
            SET status = $3, failure_reason = $4, completed_at = $5
          WHERE tenant_id = $1 AND id = $2 AND status = 'pending'`,
        [tenantId, id, result.status, result.failureReason ?? null, result.at],
      );
      return (r.rowCount ?? 0) > 0;
    });
  }
}

/** What the owner sees: the state plus plain-language next steps. */
export interface ForwardingCheckView {
  status: ForwardingCheckStatus;
  checkedAt: string | null;
  expiresAt: string | null;
  guidance: string;
}

export function describeForwardingCheck(
  check: ForwardingCheck,
  mode: CallForwardingMode,
): ForwardingCheckView {
  const base = {
    status: check.status,
    checkedAt: check.status === 'passed' ? (check.completedAt?.toISOString() ?? null) : null,
    expiresAt: check.status === 'pending' ? check.expiresAt.toISOString() : null,
  };
  switch (check.status) {
    case 'pending':
      return {
        ...base,
        guidance:
          mode === 'missed'
            ? 'Calling your business phone now. Let it ring out: do not answer it or decline the call. It can take up to a minute.'
            : 'Calling your business phone now. It should not ring, because every call is forwarded. This can take up to a minute.',
      };
    case 'passed':
      return { ...base, guidance: 'Forwarding works: the test call reached Rivet.' };
    case 'timed_out':
      return {
        ...base,
        guidance:
          mode === 'missed'
            ? 'The test call did not come back. Make sure you let your phone ring out without answering, then check that you dialed the forwarding code from your business phone and heard a confirmation. Then test again.'
            : 'The test call did not come back. Check that you dialed the forwarding code from your business phone and heard a confirmation, that the phone has signal, and that your carrier plan includes call forwarding. Then test again.',
      };
    case 'failed':
      return {
        ...base,
        guidance:
          check.failureReason === 'call_not_placed'
            ? "We couldn't place the test call. Check your business phone number in Business profile, then try again in a minute."
            : 'This test was replaced by a newer one. Start another test if you still need it.',
      };
  }
}

export interface ForwardingCheckDeps {
  repo: ForwardingCheckRepository;
  forwardingRepo: Pick<CallForwardingRepository, 'get' | 'recordCheckPassed'>;
  getBusinessPhone: (tenantId: string) => Promise<string | null>;
  getCreds: (tenantId: string) => Promise<TenantTwilioCreds>;
  auditRepo?: AuditRepository | undefined;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  apiBaseUrl?: string;
  now?: () => Date;
}

export class ForwardingCheckService {
  constructor(private readonly deps: ForwardingCheckDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private async audit(
    tenantId: string,
    actor: { id: string; role: string },
    eventType: string,
    checkId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    if (!this.deps.auditRepo) return;
    await this.deps.auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId: actor.id,
        actorRole: actor.role,
        eventType,
        entityType: 'call_forwarding_check',
        entityId: checkId,
        metadata,
      }),
    );
  }

  /** Starts a check and places the test call. Throws ValidationError when it cannot start. */
  async start(
    tenantId: string,
    actor: { id: string; role: string },
  ): Promise<{ check: ForwardingCheck; view: ForwardingCheckView }> {
    const setup = await this.deps.forwardingRepo.get(tenantId);
    if (!setup) throw new ValidationError('Pick your carrier before testing call forwarding');

    const businessRaw = await this.deps.getBusinessPhone(tenantId);
    let businessNumber: string;
    try {
      businessNumber = normalizeMobileE164(businessRaw ?? '');
    } catch {
      throw new ValidationError('Add your business phone number in Business profile, then test again');
    }

    let creds: TenantTwilioCreds;
    try {
      creds = await this.deps.getCreds(tenantId);
    } catch {
      throw new ValidationError('Your Rivet number is not ready yet');
    }
    if (!creds.accountSid || !creds.authToken || !creds.phoneE164) {
      throw new ValidationError('Your Rivet number is not ready yet');
    }
    if (creds.phoneE164 === businessNumber) {
      throw new ValidationError(
        'Your business phone number is your Rivet number. Enter the number you want to forward in Business profile.',
      );
    }

    const createdAt = this.now();
    const check: ForwardingCheck = {
      id: randomUUID(),
      tenantId,
      status: 'pending',
      mode: setup.mode,
      rivetNumber: creds.phoneE164,
      businessNumber,
      callSid: null,
      failureReason: null,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + FORWARDING_CHECK_TTL_MS),
      completedAt: null,
    };
    await this.deps.repo.create(check);
    await this.audit(tenantId, actor, 'call_forwarding.check_started', check.id, {
      mode: setup.mode,
      carrier: setup.carrier,
    });

    try {
      check.callSid = await this.placeTestCall(creds, businessNumber);
      await this.deps.repo.setCallSid(tenantId, check.id, check.callSid);
    } catch {
      await this.settle(check, actor, { status: 'failed', failureReason: 'call_not_placed' });
      check.status = 'failed';
      check.failureReason = 'call_not_placed';
    }
    return { check, view: describeForwardingCheck(check, setup.mode) };
  }

  private async placeTestCall(creds: TenantTwilioCreds, to: string): Promise<string> {
    const doFetch = this.deps.fetchImpl ?? fetch;
    const base = this.deps.apiBaseUrl ?? 'https://api.twilio.com/2010-04-01';
    const body = new URLSearchParams({
      To: to,
      From: creds.phoneE164 ?? '',
      // If the owner picks up instead of letting it forward, end the call.
      Twiml: '<Response><Hangup/></Response>',
      Timeout: String(RING_TIMEOUT_SECONDS),
    });
    const res = await doFetch(`${base}/Accounts/${creds.accountSid}/Calls.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    if (!res.ok) throw new Error(`Twilio call create failed (${res.status})`);
    const json = (await res.json()) as { sid?: string };
    if (!json.sid) throw new Error('Twilio call create returned no sid');
    return json.sid;
  }

  private async settle(
    check: ForwardingCheck,
    actor: { id: string; role: string },
    result: { status: Exclude<ForwardingCheckStatus, 'pending'>; failureReason?: ForwardingCheckFailureReason },
  ): Promise<boolean> {
    const at = this.now();
    const settled = await this.deps.repo.settle(check.tenantId, check.id, { ...result, at });
    if (!settled) return false;
    await this.audit(check.tenantId, actor, `call_forwarding.check_${result.status}`, check.id, {
      mode: check.mode,
      ...(result.failureReason ? { reason: result.failureReason } : {}),
    });
    return true;
  }

  /** The latest check as the owner sees it; a check past its window is closed as timed out. */
  async latestView(
    tenantId: string,
    actor: { id: string; role: string },
  ): Promise<ForwardingCheckView | null> {
    const latest = await this.deps.repo.latest(tenantId);
    if (!latest) return null;
    if (latest.status === 'pending' && latest.expiresAt.getTime() <= this.now().getTime()) {
      await this.settle(latest, actor, { status: 'timed_out' });
      const after = await this.deps.repo.latest(tenantId);
      if (after) return describeForwardingCheck(after, after.mode);
    }
    return describeForwardingCheck(latest, latest.mode);
  }

  /**
   * Called by the inbound voice webhook for every resolved call, before any
   * AI work. True means this call was the check coming back: the caller hangs
   * up and must not start a conversation.
   */
  async recognizeInbound(input: { tenantId: string; from: string; callSid: string }): Promise<boolean> {
    const from = input.from.trim();
    if (!from) return false;
    const check = await this.deps.repo.findPendingFrom(input.tenantId, from, this.now());
    if (!check) return false;
    const system = { id: 'system', role: 'system' };
    if (!(await this.settle(check, system, { status: 'passed' }))) return false;
    await this.deps.forwardingRepo.recordCheckPassed(input.tenantId, this.now(), check.rivetNumber);
    return true;
  }
}

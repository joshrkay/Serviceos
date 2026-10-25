/**
 * Postgres integration — the voice path's tenant_settings / voice_sessions
 * reads and writes run under the RLS runtime role (raw-pg audit 2026-10-23
 * §4 P1.2, P1.3, P1.5).
 *
 * - The inbound /voice gate (`createVoiceGate`): go-live, owner-number,
 *   forward-to and usage reads for the dialled-number tenant, on every call.
 * - Go-live (`enableVoiceAgentLive`, `pauseVoiceAgentLive`,
 *   `maybeAutoGoLiveOnInboundEnd` → `loadVoiceAgentLiveAt`): POST /go-live,
 *   /pause and the session-end auto path.
 * - Session-end hooks: `maybeFireFirstRealCallActivation`,
 *   `checkAndFireUpgradeNudge`; and the Vapi webhook's
 *   `maybeFireActivationForInboundCall`.
 *
 * Each ran `WHERE tenant_id = $1` on the raw pool as the privileged
 * principal. With RLS_RUNTIME_ROLE on, for each: it works for its own tenant
 * against the real columns, every tenant-table statement reporting
 * rls_app_runtime with the calling tenant's GUC; with the tenant pin widened
 * to both seeded tenants RLS alone keeps the other tenant out (reads) and
 * untouched (check-and-set UPDATEs); control: the widened statements as the
 * principal reach it. The gate's cost per decision (checkouts, statements,
 * connections held at once) is pinned against what it was: one tenant
 * session, whose first statement reads the tenants registry row joined to the
 * tenant_settings row.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import twilio from 'twilio';
import type { Pool } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';
import { probeStatementRoles } from './statement-role-probe';
import { countPoolTraffic, runtimeRoleGrantsMissingAfter219, widenTenantPredicates } from './tenant-predicate-probe';
import { createVoiceGate } from '../../src/voice/voice-gate';
import {
  enableVoiceAgentLive,
  maybeAutoGoLiveOnInboundEnd,
  pauseVoiceAgentLive,
} from '../../src/voice/go-live';
import { maybeFireActivationForInboundCall, maybeFireFirstRealCallActivation } from '../../src/voice/activation';
import { checkAndFireUpgradeNudge } from '../../src/voice/check-upgrade-nudge';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { applyTenantContext } from '../../src/db/rls-runtime-role';
import { tenantContextStore } from '../../src/middleware/tenant-context';
import { createTelephonyRouter } from '../../src/routes/telephony';
import { PgSettingsRepository } from '../../src/settings/pg-settings';

const ORIGINAL_FLAG = process.env.RLS_RUNTIME_ROLE;
const OWNER_PHONE = '+14805550100';
const PERIOD_START = new Date(Date.UTC(2026, 9, 1));
const PERIOD_END = new Date(Date.UTC(2099, 0, 1));
const FULL_ATTESTATION = 'TN-Validation-Passed-A';
/**
 * Every tenant-table statement these functions run. The gate's tenants
 * registry read is joined to its tenant_settings row, so it matches too.
 */
const TENANT_TABLES = /tenant_settings|voice_sessions|call_usage_events/;
/** The gate's decision row, whitespace collapsed. */
const GATE_ROW = /^SELECT t\.subscription_status, .* FROM tenants t LEFT JOIN tenant_settings s ON s\.tenant_id = \$1 WHERE t\.id = \$1$/;
/** The widening probe's target for the decision row (matched against the SQL as sent). */
const GATE_ROW_TARGET = /FROM tenants t\s+LEFT JOIN tenant_settings s\b/;
const oneLine = (sql: string) => sql.replace(/\s+/g, ' ').trim();

let pool: Pool;
const tenantIds: string[] = [];

interface VoiceTenantOpts {
  status?: 'trialing' | 'active' | 'past_due' | null;
  /** past_due_grace_until (dunning grace). */
  graceUntil?: Date;
  live?: boolean;
  activated?: boolean;
  testCallSkipped?: boolean;
  nudged?: boolean;
  ownerPhone?: string | null;
  businessHours?: object;
  /** tenant_settings.escalation_settings (default: the column default, '{}'). */
  escalationSettings?: object;
  /** Seed no tenant_settings row at all. */
  noSettingsRow?: boolean;
  endedSessions?: number;
  openSessions?: number;
  billableSeconds?: number;
}

async function seedVoiceTenant(opts: VoiceTenantOpts = {}): Promise<string> {
  const { tenantId } = await createTestTenant(pool);
  tenantIds.push(tenantId);
  await pool.query(
    `UPDATE tenants SET subscription_status = $2, plan_id = 'starter',
            current_period_start = $3, current_period_end = $4, past_due_grace_until = $5 WHERE id = $1`,
    [tenantId, opts.status === undefined ? 'trialing' : opts.status, PERIOD_START, PERIOD_END, opts.graceUntil ?? null],
  );
  await pool.query(
    `INSERT INTO tenant_settings
       (tenant_id, business_name, owner_phone, business_phone, voice_agent_live_at, activated_at,
        onboarding_test_call_skipped_at, onboarding_upgrade_prompt_shown_at, business_hours, timezone,
        escalation_settings)
     VALUES ($1, 'Voice Path Shop', $2, '+15125550999',
             CASE WHEN $3 THEN NOW() END, CASE WHEN $4 THEN NOW() END,
             CASE WHEN $5 THEN NOW() END, CASE WHEN $6 THEN NOW() END, $7::jsonb, 'America/Chicago', $8::jsonb)`,
    [
      tenantId,
      opts.ownerPhone === undefined ? OWNER_PHONE : opts.ownerPhone,
      opts.live ?? true,
      opts.activated ?? false,
      opts.testCallSkipped ?? false,
      opts.nudged ?? false,
      JSON.stringify(opts.businessHours ?? {}),
      JSON.stringify(opts.escalationSettings ?? {}),
    ],
  );
  if (opts.noSettingsRow) await pool.query(`DELETE FROM tenant_settings WHERE tenant_id = $1`, [tenantId]);
  for (let i = 0; i < (opts.endedSessions ?? 0); i++) {
    await pool.query(
      `INSERT INTO voice_sessions (tenant_id, channel, state, ended_at) VALUES ($1, 'voice_inbound', 'ended', NOW())`,
      [tenantId],
    );
  }
  for (let i = 0; i < (opts.openSessions ?? 0); i++) {
    await pool.query(
      `INSERT INTO voice_sessions (tenant_id, channel, state) VALUES ($1, 'voice_inbound', 'active')`,
      [tenantId],
    );
  }
  if (opts.billableSeconds) {
    await pool.query(
      `INSERT INTO call_usage_events (tenant_id, call_id, started_at, ended_at, duration_seconds, billable)
       VALUES ($1, $2, NOW() - $3::int * interval '1 second', NOW(), $3::int, true)`,
      [tenantId, crypto.randomUUID(), opts.billableSeconds],
    );
  }
  return tenantId;
}

async function settingsOf(tenantId: string) {
  const { rows } = await pool.query<{
    voice_agent_live_at: Date | null;
    activated_at: Date | null;
    onboarding_upgrade_prompt_shown_at: Date | null;
  }>(
    `SELECT voice_agent_live_at, activated_at, onboarding_upgrade_prompt_shown_at FROM tenant_settings WHERE tenant_id = $1`,
    [tenantId],
  );
  return rows[0]!;
}

function expectAllUnderTenant(seen: Array<{ role: string; tenantGuc: string | null }>, tenantId: string) {
  expect(seen.length).toBeGreaterThan(0);
  for (const s of seen) expect(s).toMatchObject({ role: 'rls_app_runtime', tenantGuc: tenantId });
}

beforeAll(async () => {
  pool = await getSharedTestDb();
});

beforeEach(() => {
  process.env.RLS_RUNTIME_ROLE = 'true';
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.RLS_RUNTIME_ROLE;
  else process.env.RLS_RUNTIME_ROLE = ORIGINAL_FLAG;
});

afterAll(async () => {
  for (const id of tenantIds) {
    for (const table of ['audit_events', 'call_usage_events', 'voice_sessions', 'tenant_settings', 'users']) {
      await pool.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [id]).catch(() => undefined);
    }
    await pool.query('DELETE FROM tenants WHERE id = $1', [id]).catch(() => undefined);
  }
  await closeSharedTestDb();
});

// ── The inbound /voice gate ──────────────────────────────────────────────

describe('createVoiceGate — one tenant session per decision under the RLS runtime role (real Postgres)', () => {
  const gateFor = (p: Pool) => createVoiceGate({ pool: p, auditRepo: new PgAuditRepository(pool) });

  it("answers a live trial call from its own tenant's rows, every read — the tenants row included — as rls_app_runtime", async () => {
    const tenantId = await seedVoiceTenant({ businessHours: { mon: { open: '08:00', close: '17:00' } } });
    const probe = probeStatementRoles(pool, /FROM tenants\b|tenant_settings|voice_sessions|call_usage_events/);

    const result = await gateFor(probe.pool)({ tenantId, callSid: 'CA-gate-own' });

    expect(result).toMatchObject({ allowed: true });
    expect(probe.seen.map((s) => oneLine(s.sql))).toEqual([
      expect.stringMatching(GATE_ROW),
      expect.stringMatching(/FROM voice_sessions/),
      expect.stringMatching(/FROM call_usage_events/),
    ]);
    expectAllUnderTenant(probe.seen, tenantId);
  });

  it("with the tenant pin widened to both tenants, RLS keeps the other tenant's open calls and minutes out", async () => {
    const caller = await seedVoiceTenant();
    const other = await seedVoiceTenant({ openSessions: 3, billableSeconds: 4 * 60 * 60 });
    const widened = widenTenantPredicates(pool, { target: TENANT_TABLES, tenants: [caller, other] });

    expect(await gateFor(widened.pool)({ tenantId: caller, callSid: 'CA-gate-widened' })).toMatchObject({ allowed: true });
    expect(widened.rewritten.length).toBeGreaterThan(0);
  });

  it("control: the same widened reads run as the connection principal count the other tenant's usage", async () => {
    const caller = await seedVoiceTenant();
    const other = await seedVoiceTenant({ openSessions: 3, billableSeconds: 4 * 60 * 60 });
    const widened = widenTenantPredicates(pool, { target: TENANT_TABLES, tenants: [caller, other], asPrincipal: true });

    expect(await gateFor(widened.pool)({ tenantId: caller, callSid: 'CA-gate-principal' })).toMatchObject({
      allowed: false,
      reason: 'trial_cap_total',
    });
  });

  it("the not_live owner test-call bypass compares From with its own tenant's numbers only", async () => {
    const caller = await seedVoiceTenant({ live: false, ownerPhone: '+14805550111' });
    const other = await seedVoiceTenant({ live: false, ownerPhone: OWNER_PHONE });
    const call = { tenantId: caller, callSid: 'CA-gate-owner', from: OWNER_PHONE, stirVerstat: FULL_ATTESTATION };

    const widened = widenTenantPredicates(pool, { target: TENANT_TABLES, tenants: [caller, other] });
    expect(await gateFor(widened.pool)(call)).toMatchObject({ allowed: false, reason: 'not_live' });
    // The decision's only statement is its row: the settings join is what was widened.
    expect(widened.rewritten.map(oneLine)).toEqual([expect.stringMatching(/LEFT JOIN tenant_settings s ON \(s\.tenant_id = ANY\(/)]);

    const probe = probeStatementRoles(pool, TENANT_TABLES);
    expect(await gateFor(probe.pool)({ ...call, tenantId: other })).toMatchObject({ allowed: true });
    expectAllUnderTenant(probe.seen, other);
  });

  it('a decision costs one tenant session, the tenants read included, and never holds two connections', async () => {
    // Before (one pool read per question): live trial 5 checkouts / 11
    // statements; paid with a period 5 / 17; not_live 2 / 2 + the audit.
    const trial = await seedVoiceTenant();
    const paid = await seedVoiceTenant({ status: 'active' });
    const grace = await seedVoiceTenant({ status: 'past_due', graceUntil: new Date(Date.now() + 86_400_000) });
    const notLive = await seedVoiceTenant({ live: false });
    const noBilling = await seedVoiceTenant({ status: null });

    const measure = async (tenantId: string, call: { from?: string; stirVerstat?: string } = {}) => {
      const traffic = countPoolTraffic(pool);
      const gate = createVoiceGate({ pool: traffic.pool, auditRepo: new PgAuditRepository(traffic.pool) });
      const result = await gate({ tenantId, callSid: `CA-gate-cost-${tenantId.slice(0, 8)}`, ...call });
      return { allowed: result.allowed, checkouts: traffic.checkouts(), statements: traffic.statements().length, maxOpen: traffic.maxOpen() };
    };

    // BEGIN, GUC+role, the tenants+settings row, open calls, minutes, COMMIT (6).
    expect(await measure(trial)).toEqual({ allowed: true, checkouts: 1, statements: 6, maxOpen: 1 });
    // BEGIN, GUC+role, the row, period minutes, COMMIT (5).
    expect(await measure(paid)).toEqual({ allowed: true, checkouts: 1, statements: 5, maxOpen: 1 });
    // Dunning grace: BEGIN, GUC+role, the row, COMMIT (4).
    expect(await measure(grace)).toEqual({ allowed: true, checkouts: 1, statements: 4, maxOpen: 1 });
    // The #1605 owner test call while not_live: the same 4.
    expect(await measure(notLive, { from: OWNER_PHONE, stirVerstat: FULL_ATTESTATION })).toEqual({
      allowed: true,
      checkouts: 1,
      statements: 4,
      maxOpen: 1,
    });
    // Voicemail blocks: the 4 + the audit write's own transaction (6).
    expect(await measure(notLive)).toEqual({ allowed: false, checkouts: 2, statements: 10, maxOpen: 1 });
    expect(await measure(noBilling)).toEqual({ allowed: false, checkouts: 2, statements: 10, maxOpen: 1 });
  });

  it("a dunning-grace answer carries its own tenant's business hours and after-hours mode, read as rls_app_runtime", async () => {
    const hours = { mon: { open: '08:00', close: '17:00' } };
    const tenantId = await seedVoiceTenant({ status: 'past_due', graceUntil: new Date(Date.now() + 86_400_000), live: false, businessHours: hours });
    const other = await seedVoiceTenant({
      businessHours: { tue: { open: '09:00', close: '10:00' } },
      escalationSettings: { after_hours_voice_mode: 'voicemail' },
    });
    const probe = probeStatementRoles(pool, TENANT_TABLES);

    const result = await gateFor(probe.pool)({ tenantId, callSid: 'CA-gate-grace' });

    expect(result).toEqual({
      allowed: true,
      businessHours: { timezone: 'America/Chicago', schedule: [{ dayOfWeek: 1, openTime: '08:00', closeTime: '17:00' }] },
      // No key stored on the caller's row: the #1595 default (the other tenant's 'voicemail' never leaks in).
      afterHoursVoiceMode: 'ai_answering',
    });
    expect(probe.seen.map((s) => oneLine(s.sql))).toEqual([expect.stringMatching(GATE_ROW)]);
    expectAllUnderTenant(probe.seen, tenantId);
    // With the settings join's tenant pin widened to both tenants, RLS still hands back only the caller's row.
    const widened = widenTenantPredicates(pool, { target: GATE_ROW_TARGET, tenants: [tenantId, other] });
    expect(await gateFor(widened.pool)({ tenantId, callSid: 'CA-gate-grace-widened' })).toEqual(result);
    expect(widened.rewritten.map(oneLine)).toEqual([expect.stringMatching(/LEFT JOIN tenant_settings s ON \(s\.tenant_id = ANY\(/)]);
  });
});

describe('POST /api/telephony/voice — gate and after-hours fork share the one tenant session (real Postgres)', () => {
  const AUTH_TOKEN = 'voice-path-tenant-context-token';
  const BASE = 'https://api.voice-path.test';

  it('an answered call reads tenant_settings once: the after-hours fork reuses the gate\'s row', async () => {
    // Before: the gate's 5 checkouts / 11 statements plus the after-hours
    // fork's own read (1 / 1) = 6 / 12 for a live trial call.
    const tenantId = await seedVoiceTenant({ businessHours: { mon: { open: '08:00', close: '17:00' } } });
    const traffic = countPoolTraffic(pool);
    let answered = 0;
    const app = express();
    app.use(
      '/api/telephony',
      createTelephonyRouter({
        adapter: {
          handleInbound: async () => {
            answered += 1;
            return '<Response><Gather/></Response>';
          },
          handleInboundForStream: async () => '<Response/>',
          handleGather: async () => '<Response/>',
        } as never,
        authTokenGetter: () => AUTH_TOKEN,
        publicBaseUrl: BASE,
        resolveTenantId: () => tenantId,
        voiceGate: createVoiceGate({ pool: traffic.pool, auditRepo: new PgAuditRepository(traffic.pool) }),
        pool: traffic.pool,
        // 'ai_answering' so an after-hours verdict still answers: the fork's read is what is measured.
        settingsRepo: { findByTenant: async () => ({ escalationSettings: { after_hours_voice_mode: 'ai_answering' } }) } as never,
      }),
    );
    const params = { CallSid: 'CA-voice-route-cost', From: '+15125550123', To: '+15125550999' };
    const sig = twilio.getExpectedTwilioSignature(AUTH_TOKEN, `${BASE}/api/telephony/voice`, params);

    const res = await request(app).post('/api/telephony/voice').set('X-Twilio-Signature', sig).type('form').send(params);

    expect(res.status).toBe(200);
    expect(answered).toBe(1);
    expect(traffic.statements().filter((s) => /tenant_settings/.test(s)).map(oneLine)).toEqual([expect.stringMatching(GATE_ROW)]);
    // One checkout: the gate's session (BEGIN, GUC+role, the row, open calls, minutes, COMMIT).
    expect({ checkouts: traffic.checkouts(), statements: traffic.statements().length, maxOpen: traffic.maxOpen() }).toEqual({
      checkouts: 1,
      statements: 6,
      maxOpen: 1,
    });
  });

  it('a dunning-grace call: the gate reads the hours and the mode in its session and the after-hours fork reads nothing itself', async () => {
    // Base (raw pool reads): the tenants read + the fork's business-hours read = 2 checkouts / 2.
    const closedAllWeek = Object.fromEntries(
      ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: '00:00', close: '00:01' }]),
    );
    const tenantId = await seedVoiceTenant({
      status: 'past_due',
      graceUntil: new Date(Date.now() + 86_400_000),
      businessHours: closedAllWeek,
      escalationSettings: { after_hours_voice_mode: 'voicemail' },
    });
    const traffic = countPoolTraffic(pool);
    let answered = 0;
    const app = express();
    app.use(
      '/api/telephony',
      createTelephonyRouter({
        adapter: {
          handleInbound: async () => {
            answered += 1;
            return '<Response><Gather/></Response>';
          },
          handleInboundForStream: async () => '<Response/>',
          handleGather: async () => '<Response/>',
        } as never,
        authTokenGetter: () => AUTH_TOKEN,
        publicBaseUrl: BASE,
        resolveTenantId: () => tenantId,
        voiceGate: createVoiceGate({ pool: traffic.pool, auditRepo: new PgAuditRepository(traffic.pool) }),
        pool: traffic.pool,
        // After hours sends the call to voicemail: proof the fork used the gate's hours and mode.
        settingsRepo: new PgSettingsRepository(traffic.pool),
      }),
    );
    const params = { CallSid: 'CA-voice-route-grace', From: '+15125550123', To: '+15125550999' };
    const sig = twilio.getExpectedTwilioSignature(AUTH_TOKEN, `${BASE}/api/telephony/voice`, params);

    const res = await request(app).post('/api/telephony/voice').set('X-Twilio-Signature', sig).type('form').send(params);

    expect(res.status).toBe(200);
    expect(answered).toBe(0);
    expect(res.text).toContain('<Record');
    // The one tenant_settings read is the gate's decision row, inside its tenant session.
    const statements = traffic.statements().map(oneLine);
    expect(statements.filter((s) => /tenant_settings/.test(s))).toEqual([expect.stringMatching(GATE_ROW)]);
    // BEGIN, GUC+role, the row, COMMIT (4). Base (raw pool reads) was 2 / 2:
    // the RLS floor for a tenant_settings read is the 4 statements of a session.
    expect({ checkouts: traffic.checkouts(), statements: statements.length, maxOpen: traffic.maxOpen() }).toEqual({
      checkouts: 1,
      statements: 4,
      maxOpen: 1,
    });
  });
});

describe('POST /api/telephony/voice after hours — the fork acts on the gate\'s after-hours mode: tenant_settings read once (real Postgres)', () => {
  const AUTH_TOKEN = 'voice-path-after-hours-token';
  const BASE = 'https://api.voice-path-after-hours.test';
  /** open === close: closed at every minute of every day, whatever the wall clock. */
  const ALWAYS_CLOSED = Object.fromEntries(
    ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: '00:00', close: '00:00' }]),
  );
  const GRACE = { status: 'past_due' as const, graceUntil: new Date(Date.now() + 86_400_000) };
  const TRIAL = { status: 'trialing' as const };
  const PAID = { status: 'active' as const };

  /**
   * POST /voice with the production wiring: the real gate, the real
   * PgSettingsRepository (the fork's fallback read), both on one counted pool.
   */
  async function postVoice(tenantId: string, callSid: string) {
    const traffic = countPoolTraffic(pool);
    let answered = 0;
    const app = express();
    app.use(
      '/api/telephony',
      createTelephonyRouter({
        adapter: {
          handleInbound: async () => {
            answered += 1;
            return '<Response><Gather/></Response>';
          },
          handleInboundForStream: async () => '<Response/>',
          handleGather: async () => '<Response/>',
        } as never,
        authTokenGetter: () => AUTH_TOKEN,
        publicBaseUrl: BASE,
        resolveTenantId: () => tenantId,
        voiceGate: createVoiceGate({ pool: traffic.pool, auditRepo: new PgAuditRepository(traffic.pool) }),
        pool: traffic.pool,
        settingsRepo: new PgSettingsRepository(traffic.pool),
      }),
    );
    const params = { CallSid: callSid, From: '+15125550123', To: '+15125550999' };
    const sig = twilio.getExpectedTwilioSignature(AUTH_TOKEN, `${BASE}/api/telephony/voice`, params);
    const res = await request(app).post('/api/telephony/voice').set('X-Twilio-Signature', sig).type('form').send(params);
    expect(res.status).toBe(200);
    const statements = traffic.statements().map(oneLine);
    return {
      outcome: res.text.includes('<Record') && res.text.includes('/api/telephony/voicemail-status') ? 'voicemail' : answered === 1 ? 'ai' : 'other',
      settingsReads: statements.filter((s) => /tenant_settings/.test(s)).length,
      checkouts: traffic.checkouts(),
      statements: statements.length,
      maxOpen: traffic.maxOpen(),
    };
  }

  // Before: the gate's session, then the fork's settingsRepo.findByTenant for
  // the mode — a second session (BEGIN, GUC+role, SELECT * FROM
  // tenant_settings, COMMIT, RESET ROLE, RESET the GUC): grace 2 / 10, trial
  // 2 / 12, paid 2 / 11. Now the gate's session alone.
  const paths = [
    // Dunning grace: BEGIN, GUC+role, the row, COMMIT (4).
    { path: 'dunning grace', seed: GRACE, statements: 4 },
    // BEGIN, GUC+role, the row, open calls, minutes, COMMIT (6).
    { path: 'a live trial', seed: TRIAL, statements: 6 },
    // BEGIN, GUC+role, the row, period minutes, COMMIT (5).
    { path: 'a paid tenant', seed: PAID, statements: 5 },
  ];
  const modes: Array<{ label: string; escalationSettings: object; outcome: 'ai' | 'voicemail' }> = [
    { label: 'no mode stored (the #1595 default)', escalationSettings: {}, outcome: 'ai' },
    { label: "'ai_answering'", escalationSettings: { after_hours_voice_mode: 'ai_answering' }, outcome: 'ai' },
    { label: "'voicemail'", escalationSettings: { after_hours_voice_mode: 'voicemail' }, outcome: 'voicemail' },
  ];

  for (const { path, seed, statements } of paths) {
    for (const { label, escalationSettings, outcome } of modes) {
      it(`${path}, ${label}: ${outcome === 'ai' ? 'the AI answers' : 'voicemail'}, one tenant session (${statements} statements)`, async () => {
        const tenantId = await seedVoiceTenant({ ...seed, businessHours: ALWAYS_CLOSED, escalationSettings });

        expect(await postVoice(tenantId, `CA-ah-${tenantId.slice(0, 8)}`)).toEqual({
          outcome,
          settingsReads: 1,
          checkouts: 1,
          statements,
          maxOpen: 1,
        });
      });
    }
  }

  // The write paths store only the enum, but a hand-written row routes as the
  // fork's own read routed it: any stored value but 'ai_answering' (a JSON null
  // included — a value, not an absent key) is voicemail; a blob that is not an
  // object, or has no such key, is the default.
  it.each([
    ['a stored JSON null', { after_hours_voice_mode: null }, 'voicemail'],
    ['a value outside the enum', { after_hours_voice_mode: 'forward' }, 'voicemail'],
    ['other keys only', { channel_sms: false }, 'ai'],
    ['an array naming the key', ['after_hours_voice_mode'], 'ai'],
  ])('dunning grace after hours, %s: as the fork routed it, in one session', async (_label, escalationSettings, outcome) => {
    const tenantId = await seedVoiceTenant({ ...GRACE, businessHours: ALWAYS_CLOSED, escalationSettings });

    expect(await postVoice(tenantId, `CA-ah-odd-${tenantId.slice(0, 8)}`)).toEqual({
      outcome,
      settingsReads: 1,
      checkouts: 1,
      statements: 4,
      maxOpen: 1,
    });
  });

  it('dunning grace with no tenant_settings row: no hours, so never after hours — the AI answers, nothing re-read', async () => {
    const tenantId = await seedVoiceTenant({ ...GRACE, noSettingsRow: true });

    expect(await postVoice(tenantId, 'CA-ah-no-row')).toEqual({ outcome: 'ai', settingsReads: 1, checkouts: 1, statements: 4, maxOpen: 1 });
  });

  it('in hours (no schedule) the mode is never consulted: grace, trial and paid cost what they did', async () => {
    const vm = { after_hours_voice_mode: 'voicemail' };
    const grace = await seedVoiceTenant({ ...GRACE, escalationSettings: vm });
    const trial = await seedVoiceTenant({ ...TRIAL, escalationSettings: vm });
    const paid = await seedVoiceTenant({ ...PAID, escalationSettings: vm });

    expect(await postVoice(grace, 'CA-ih-grace')).toEqual({ outcome: 'ai', settingsReads: 1, checkouts: 1, statements: 4, maxOpen: 1 });
    expect(await postVoice(trial, 'CA-ih-trial')).toEqual({ outcome: 'ai', settingsReads: 1, checkouts: 1, statements: 6, maxOpen: 1 });
    expect(await postVoice(paid, 'CA-ih-paid')).toEqual({ outcome: 'ai', settingsReads: 1, checkouts: 1, statements: 5, maxOpen: 1 });
  });
});

// ── Go-live ──────────────────────────────────────────────────────────────

describe('go-live — voice_agent_live_at check-and-set under the RLS runtime role (real Postgres)', () => {
  const audit = () => new PgAuditRepository(pool);

  it('enable stamps its own tenant (re-reading under the same context) and pause clears it, as rls_app_runtime', async () => {
    const tenantId = await seedVoiceTenant({ live: false });
    const probe = probeStatementRoles(pool, TENANT_TABLES);

    const first = await enableVoiceAgentLive({ pool: probe.pool, auditRepo: audit() }, { tenantId, actorId: 'u1', source: 'manual' });
    const again = await enableVoiceAgentLive({ pool: probe.pool, auditRepo: audit() }, { tenantId, actorId: 'u1', source: 'manual' });
    expect(first.voiceAgentLive).toBe(true);
    expect(again.voiceAgentLiveAt).toBe(first.voiceAgentLiveAt);

    await pauseVoiceAgentLive({ pool: probe.pool, auditRepo: audit() }, { tenantId, actorId: 'u1' });
    expect((await settingsOf(tenantId)).voice_agent_live_at).toBeNull();

    // UPDATE, UPDATE (0 rows) + its re-read, pause UPDATE: 4 statements.
    expect(probe.seen).toHaveLength(4);
    expectAllUnderTenant(probe.seen, tenantId);
  });

  it('the session-end auto go-live reads voice_agent_live_at under tenant context and stamps once', async () => {
    const tenantId = await seedVoiceTenant({ live: false });
    const probe = probeStatementRoles(pool, TENANT_TABLES);

    await maybeAutoGoLiveOnInboundEnd({ pool: probe.pool, auditRepo: audit() }, { tenantId, channel: 'voice_inbound' });
    await maybeAutoGoLiveOnInboundEnd({ pool: probe.pool, auditRepo: audit() }, { tenantId, channel: 'voice_inbound' });

    expect((await settingsOf(tenantId)).voice_agent_live_at).not.toBeNull();
    expectAllUnderTenant(probe.seen, tenantId);
  });

  it("with the tenant pin widened to both tenants, enable and pause leave the other tenant's row alone", async () => {
    const offCaller = await seedVoiceTenant({ live: false });
    const offOther = await seedVoiceTenant({ live: false });
    const onCaller = await seedVoiceTenant({ live: true });
    const onOther = await seedVoiceTenant({ live: true });

    const w1 = widenTenantPredicates(pool, { target: TENANT_TABLES, tenants: [offCaller, offOther] });
    await enableVoiceAgentLive({ pool: w1.pool, auditRepo: audit() }, { tenantId: offCaller, actorId: 'u1', source: 'manual' });
    const w2 = widenTenantPredicates(pool, { target: TENANT_TABLES, tenants: [onCaller, onOther] });
    await pauseVoiceAgentLive({ pool: w2.pool, auditRepo: audit() }, { tenantId: onCaller, actorId: 'u1' });

    expect(w1.rewritten.length).toBeGreaterThan(0);
    expect(w2.rewritten.length).toBeGreaterThan(0);
    expect((await settingsOf(offCaller)).voice_agent_live_at).not.toBeNull();
    expect((await settingsOf(offOther)).voice_agent_live_at).toBeNull();
    expect((await settingsOf(onCaller)).voice_agent_live_at).toBeNull();
    expect((await settingsOf(onOther)).voice_agent_live_at).not.toBeNull();
  });

  it('control: the same widened UPDATEs run as the connection principal flip the other tenant too', async () => {
    const offCaller = await seedVoiceTenant({ live: false });
    const offOther = await seedVoiceTenant({ live: false });
    const onCaller = await seedVoiceTenant({ live: true });
    const onOther = await seedVoiceTenant({ live: true });

    const w1 = widenTenantPredicates(pool, { target: TENANT_TABLES, tenants: [offCaller, offOther], asPrincipal: true });
    await enableVoiceAgentLive({ pool: w1.pool, auditRepo: audit() }, { tenantId: offCaller, actorId: 'u1', source: 'manual' });
    const w2 = widenTenantPredicates(pool, { target: TENANT_TABLES, tenants: [onCaller, onOther], asPrincipal: true });
    await pauseVoiceAgentLive({ pool: w2.pool, auditRepo: audit() }, { tenantId: onCaller, actorId: 'u1' });

    expect((await settingsOf(offOther)).voice_agent_live_at).not.toBeNull();
    expect((await settingsOf(onOther)).voice_agent_live_at).toBeNull();
  });

  it('inside a request (POST /go-live, /pause), the stamp rides the request transaction with its audit row', async () => {
    const tenantId = await seedVoiceTenant({ live: false });
    const traffic = countPoolTraffic(pool);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await applyTenantContext(client, tenantId, { transactional: true });
      await tenantContextStore.run({ client, tenantId }, async () => {
        await enableVoiceAgentLive({ pool: traffic.pool, auditRepo: new PgAuditRepository(traffic.pool) }, {
          tenantId,
          actorId: 'u1',
          source: 'manual',
        });
        await pauseVoiceAgentLive({ pool: traffic.pool, auditRepo: new PgAuditRepository(traffic.pool) }, {
          tenantId,
          actorId: 'u1',
        });
        await enableVoiceAgentLive({ pool: traffic.pool, auditRepo: new PgAuditRepository(traffic.pool) }, {
          tenantId,
          actorId: 'u1',
          source: 'manual',
        });
      });
      // A failed request rolls back: neither the stamp nor its audit rows may survive.
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    expect(traffic.checkouts()).toBe(0);
    expect((await settingsOf(tenantId)).voice_agent_live_at).toBeNull();
    const { rows } = await pool.query(
      `SELECT 1 FROM audit_events WHERE tenant_id = $1 AND event_type IN ('tenant.voice_agent_live', 'tenant.voice_agent_paused')`,
      [tenantId],
    );
    expect(rows).toHaveLength(0);
  });
});

// ── Session-end hooks and the Vapi activation ───────────────────────────

describe('session-end hooks — activation and the upgrade nudge under the RLS runtime role (real Postgres)', () => {
  const audit = () => new PgAuditRepository(pool);

  it('first-real-call activation reads and stamps its own tenant, every statement as rls_app_runtime', async () => {
    const tenantId = await seedVoiceTenant({ testCallSkipped: true, endedSessions: 1 });
    const probe = probeStatementRoles(pool, /tenant_settings|voice_sessions|FROM tenants\b/);

    expect(await maybeFireFirstRealCallActivation({ pool: probe.pool, auditRepo: audit() }, { tenantId, channel: 'voice_inbound' })).toEqual({ fired: true });

    expect((await settingsOf(tenantId)).activated_at).not.toBeNull();
    expect(probe.seen).toHaveLength(4);
    expectAllUnderTenant(probe.seen, tenantId);
  });

  it('caller-identity activation (Vapi webhook) reads and stamps its own tenant as rls_app_runtime', async () => {
    const tenantId = await seedVoiceTenant();
    const probe = probeStatementRoles(pool, /tenant_settings|FROM tenants\b/);

    expect(
      await maybeFireActivationForInboundCall({ pool: probe.pool, auditRepo: audit() }, { tenantId, fromE164: '+15125550177' }),
    ).toEqual({ fired: true });
    expect(probe.seen).toHaveLength(3);
    expectAllUnderTenant(probe.seen, tenantId);
  });

  it('the upgrade nudge reads, sums and stamps its own tenant as rls_app_runtime', async () => {
    const tenantId = await seedVoiceTenant({ billableSeconds: 45 * 60 });
    const probe = probeStatementRoles(pool, TENANT_TABLES);

    expect(await checkAndFireUpgradeNudge({ pool: probe.pool }, tenantId)).toEqual({ fired: true });

    expect((await settingsOf(tenantId)).onboarding_upgrade_prompt_shown_at).not.toBeNull();
    expect(probe.seen).toHaveLength(3);
    expectAllUnderTenant(probe.seen, tenantId);
  });

  async function runAllWidened(asPrincipal: boolean) {
    const t = {
      firstCaller: await seedVoiceTenant({ testCallSkipped: true, endedSessions: 1 }),
      firstOther: await seedVoiceTenant({ testCallSkipped: true, endedSessions: 1 }),
      vapiCaller: await seedVoiceTenant(),
      vapiOther: await seedVoiceTenant(),
      nudgeCaller: await seedVoiceTenant({ billableSeconds: 45 * 60 }),
      nudgeOther: await seedVoiceTenant({ billableSeconds: 45 * 60 }),
    };
    const target = /tenant_settings|voice_sessions|call_usage_events/;
    const w1 = widenTenantPredicates(pool, { target, tenants: [t.firstCaller, t.firstOther], asPrincipal });
    await maybeFireFirstRealCallActivation({ pool: w1.pool, auditRepo: audit() }, { tenantId: t.firstCaller, channel: 'voice_inbound' });
    const w2 = widenTenantPredicates(pool, { target, tenants: [t.vapiCaller, t.vapiOther], asPrincipal });
    await maybeFireActivationForInboundCall({ pool: w2.pool, auditRepo: audit() }, { tenantId: t.vapiCaller, fromE164: '+15125550177' });
    const w3 = widenTenantPredicates(pool, { target, tenants: [t.nudgeCaller, t.nudgeOther], asPrincipal });
    await checkAndFireUpgradeNudge({ pool: w3.pool }, t.nudgeCaller);
    for (const w of [w1, w2, w3]) expect(w.rewritten.length).toBeGreaterThan(0);
    return {
      firstCaller: (await settingsOf(t.firstCaller)).activated_at !== null,
      firstOther: (await settingsOf(t.firstOther)).activated_at !== null,
      vapiCaller: (await settingsOf(t.vapiCaller)).activated_at !== null,
      vapiOther: (await settingsOf(t.vapiOther)).activated_at !== null,
      nudgeCaller: (await settingsOf(t.nudgeCaller)).onboarding_upgrade_prompt_shown_at !== null,
      nudgeOther: (await settingsOf(t.nudgeOther)).onboarding_upgrade_prompt_shown_at !== null,
    };
  }

  it("with the tenant pin widened to both tenants, each once-only stamp lands on its own tenant only", async () => {
    expect(await runAllWidened(false)).toEqual({
      firstCaller: true,
      firstOther: false,
      vapiCaller: true,
      vapiOther: false,
      nudgeCaller: true,
      nudgeOther: false,
    });
  });

  it('control: the same widened statements run as the connection principal stamp the other tenant too', async () => {
    expect(await runAllWidened(true)).toEqual({
      firstCaller: true,
      firstOther: true,
      vapiCaller: true,
      vapiOther: true,
      nudgeCaller: true,
      nudgeOther: true,
    });
  });
});

describe('grants: rls_app_runtime keeps what the voice path needs after migration 219', () => {
  it('tenants, tenant_settings, voice_sessions and call_usage_events stay readable, tenant_settings writable', async () => {
    expect(
      await runtimeRoleGrantsMissingAfter219(pool, [
        ['tenants', 'SELECT'],
        ['tenant_settings', 'SELECT'],
        ['tenant_settings', 'UPDATE'],
        ['voice_sessions', 'SELECT'],
        ['call_usage_events', 'SELECT'],
      ]),
    ).toEqual([]);
  });
});

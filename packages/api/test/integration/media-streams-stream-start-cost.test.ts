/**
 * Postgres integration — what a Media Streams call's stream start costs the
 * pool, under RLS_RUNTIME_ROLE=true, wired as app.ts wires it:
 *
 *   WS `start` → initialLanguageResolver (twilioAdapter.resolveStreamOpeningLanguage:
 *                tenant settings, identifyCaller, the matched customer's
 *                preferred language) → Deepgram opens in that language
 *              → initializeSession (twilioAdapter.initializeStreamSession →
 *                bootstrapCallEstablishment: language pin, disclosure,
 *                identify, greeting)
 *
 * Both steps need the caller's identity, and both are awaited before the
 * caller hears the greeting. identifyCaller is one tenant session
 * (rls_app_runtime), so it runs ONCE per stream call: the resolver parks its
 * result on the session and the bootstrap takes it (raw-pg audit round 2).
 * Real repositories, real Postgres; only the WS, STT and TTS are fakes.
 */
import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';
import { countPoolTraffic } from './tenant-predicate-probe';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { TwilioMediaStreamAdapter, type WsLike } from '../../src/telephony/media-streams/mediastream-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import type {
  StreamingSession,
  StreamingTranscriptCallback,
  StreamingTranscriptionProvider,
} from '../../src/voice/transcription-providers';

const ORIGINAL_FLAG = process.env.RLS_RUNTIME_ROLE;
const CALLER = '+15125550177';
/** identifyCaller's lookup, and nothing else. */
const IDENTIFY_SQL = /FROM customers\s+WHERE tenant_id = \$1\s+AND phone_normalized IN/;

class FakeWs implements WsLike {
  closed = false;
  sent: Array<Record<string, unknown>> = [];
  private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    this.closed = true;
    this.fire('close');
  }
  on(event: string, listener: (...args: unknown[]) => void): void {
    (this.listeners[event] ??= []).push(listener);
  }
  private fire(event: string, ...args: unknown[]): void {
    for (const l of this.listeners[event] ?? []) l(...args);
  }
  inboundJson(obj: unknown): void {
    this.fire('message', JSON.stringify(obj));
  }
}

const PLAYABLE_TTS = {
  synthesize: vi.fn(async () => ({ audio: Buffer.alloc(640), contentType: 'audio/pcm', provider: 'test' })),
};

const sleep = (ms: number) =>
  new Promise<void>((r) => {
    setTimeout(r, ms);
  });

/** The greeting turn's completion mark: the bootstrap ran and the greeting streamed out. */
async function waitForGreetingMark(ws: FakeWs, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const mark = ws.sent.find(
      (f) => f.event === 'mark' && String((f.mark as { name?: string } | undefined)?.name ?? '').startsWith('silence-arm-'),
    );
    if (mark) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for the greeting mark');
    await sleep(10);
  }
}

let pool: Pool;
const tenantIds: string[] = [];

async function seedTenant(opts: { preferredLanguage: 'en' | 'es' | null; known: boolean }): Promise<{ tenantId: string; customerId: string }> {
  const { tenantId, userId } = await createTestTenant(pool);
  tenantIds.push(tenantId);
  await pool.query(
    `INSERT INTO tenant_settings (tenant_id, business_name, default_language, supported_languages, timezone)
     VALUES ($1, 'Stream Start Co', 'en', '{en,es}', 'America/Chicago')`,
    [tenantId],
  );
  const customerId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO customers (id, tenant_id, first_name, last_name, display_name, primary_phone, preferred_language, created_by)
     VALUES ($1, $2, 'Ana', 'Ruiz', 'Ana Ruiz', $3, $4, $5)`,
    [customerId, tenantId, opts.known ? CALLER : '+15125550100', opts.preferredLanguage, userId],
  );
  return { tenantId, customerId };
}

async function streamStart(tenantId: string, callSid: string) {
  const traffic = countPoolTraffic(pool);
  const store = new VoiceSessionStore({ startInterval: false });
  const twilioAdapter = new TwilioGatherAdapter({
    store,
    gateway: { complete: vi.fn() } as never,
    pool: traffic.pool,
    settingsRepo: new PgSettingsRepository(traffic.pool),
    customerRepo: new PgCustomerRepository(traffic.pool),
    businessName: 'Stream Start Co',
  });
  // Phase A, the /voice webhook — not part of the stream start measured below.
  await twilioAdapter.handleInboundForStream({ callSid, from: CALLER, tenantId });
  const atWebhook = { checkouts: traffic.checkouts(), statements: traffic.statements().length };

  const ws = new FakeWs();
  const sttSession = { send: vi.fn(), finish: vi.fn(), destroy: vi.fn() };
  const openSession = vi.fn((_onEvent: StreamingTranscriptCallback) =>
    Promise.resolve(sttSession as unknown as StreamingSession),
  );
  const provider: StreamingTranscriptionProvider = { openSession };
  const mediaAdapter = new TwilioMediaStreamAdapter(
    {
      store,
      streamingProvider: provider,
      ttsProvider: PLAYABLE_TTS,
      speechTurn: async () => [],
      // As app.ts wires the two stream-start hooks.
      initialLanguageResolver: (tid, ctx) => twilioAdapter.resolveStreamOpeningLanguage(tid, ctx),
      initializeSession: ({ callSid: sid, tenantId: tid }) => twilioAdapter.initializeStreamSession({ callSid: sid, tenantId: tid }),
    },
    ws,
  );
  mediaAdapter.start();
  ws.inboundJson({
    event: 'start',
    streamSid: `MZ-${callSid}`,
    start: { callSid, accountSid: 'AC', streamSid: `MZ-${callSid}`, tracks: ['inbound'] },
  });
  await waitForGreetingMark(ws);

  const statements = traffic.statements().slice(atWebhook.statements);
  return {
    session: store.findByCallSid(callSid)!,
    openedIn: openSession.mock.calls[0]?.[3] as string | undefined,
    identifyReads: statements.filter((s) => IDENTIFY_SQL.test(s)).length,
    cost: { checkouts: traffic.checkouts() - atWebhook.checkouts, statements: statements.length, maxOpen: traffic.maxOpen() },
    close: () => ws.close(),
  };
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
    for (const table of ['audit_events', 'customers', 'tenant_settings', 'users']) {
      await pool.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [id]).catch(() => undefined);
    }
    await pool.query('DELETE FROM tenants WHERE id = $1', [id]).catch(() => undefined);
  }
  await closeSharedTestDb();
});

describe('Media Streams stream start — identifyCaller once per call (real Postgres, RLS_RUNTIME_ROLE=true)', () => {
  it('a known caller: one customers lookup feeds both the opening language and the greeting bootstrap', async () => {
    const { tenantId, customerId } = await seedTenant({ preferredLanguage: 'es', known: true });

    const start = await streamStart(tenantId, 'CA-stream-start-known');
    start.close();

    // The resolver's lookup decided the language Deepgram opened in...
    expect(start.openedIn).toBe('es');
    // ...and the bootstrap took the same answer: the known-caller branch, no second read.
    expect(start.session.customerId).toBe(customerId);
    expect(start.identifyReads).toBe(1);
    // resolver: settings (6) + identify (4) + the matched customer (6); bootstrap: settings (6)
    // + the known caller's customer row (6). A repository read is BEGIN, GUC+role, SELECT, COMMIT
    // and clearTenantContext's two RESETs; identifyCaller's withTenantConnection has no RESETs.
    // Before (identifyCaller in the resolver AND again in the bootstrap): 6 checkouts / 32.
    expect(start.cost).toEqual({ checkouts: 5, statements: 28, maxOpen: 1 });
  });

  it('an unknown caller: one lookup, the tenant default language, the unknown-caller branch', async () => {
    const { tenantId } = await seedTenant({ preferredLanguage: 'es', known: false });

    const start = await streamStart(tenantId, 'CA-stream-start-unknown');
    start.close();

    expect(start.openedIn).toBe('en');
    expect(start.session.customerId).toBeUndefined();
    expect(start.identifyReads).toBe(1);
    // resolver: settings (6) + identify (4); bootstrap: settings (6). Before: 4 checkouts / 20.
    expect(start.cost).toEqual({ checkouts: 3, statements: 16, maxOpen: 1 });
  });
});

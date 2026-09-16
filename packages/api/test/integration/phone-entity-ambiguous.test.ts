/**
 * #1118 — row 3.7 on the phone: "the AI asks instead of guessing when two
 * customers share a name".
 *
 * The defect: `entity_ambiguous` — the FSM event that turns a same-name
 * collision into a disambiguation question (transitions.ts, "ask
 * disambiguation question") — was dispatched ONLY by the in-app adapter.
 * Both telephony transports (classic Gather in telephony/twilio-adapter.ts
 * and media streams via ai/voice-turn/create-voice-turn-processor.ts) ran the
 * same shared `resolveSchedulingEntities`, then folded whatever came back into
 * `entity_resolved` — so two "Jamie Rivera" rows produced no question at all
 * and the call went straight to the create-job readback with no customer id.
 *
 * Proven here at REAL Postgres, two ways:
 *
 *   A. Through the REAL `createApp()` Express app with self-signed Twilio
 *      webhooks (`/api/telephony/voice` → `/api/telephony/gather`), the way
 *      Twilio drives a live call: the TwiML `<Say>` asks, the `entity_ambiguous`
 *      audit row lands with exactly tenant A's two candidates, and the
 *      caller's "the one on 12 Oak Street" follow-up resolves (the call moves
 *      on to the readback instead of asking again).
 *   B. Through `TwilioGatherAdapter.handleGather` — the exact method the signed
 *      route calls — over real Pg repositories, so the FSM context and the
 *      persisted proposal row are observable: the follow-up resolves to the
 *      12 Oak Street customer (never the 48 Pine Avenue one, never tenant B's)
 *      and a real "yes" drafts the create_job proposal carrying that id.
 *
 * Tenant grade (T1): tenant B holds its OWN "Jamie Rivera" at the SAME street
 * address as tenant A's first one — the most tempting wrong candidate there
 * is. It is never a candidate on tenant A's call, and tenant B's own call is
 * unaffected (one match → straight to its readback, no question).
 *
 * Deterministic without a model: the owner-line `create_job` utterance is
 * matched by `OWNER_OPERATOR_COMMAND_PATTERNS` (no LLM), the ambiguity comes
 * from `PgEntityResolver` (pg_trgm), and the follow-up is placed by the shared
 * `matchDisambiguationFollowUp` over the address hint. Only leg B's final
 * "yes" goes to the (scripted) gateway, because `confirmIntent` is an LLM
 * yes/no on the phone.
 *
 * Run (Docker-gated):
 *   cd packages/api && RLS_RUNTIME_ROLE=true EXTERNAL_TEST_DB_URL=… npx vitest run \
 *     --config vitest.integration.config.ts --reporter=verbose \
 *     test/integration/phone-entity-ambiguous.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import { Pool } from 'pg';
import twilio from 'twilio';
import type { Express } from 'express';
import { getSharedTestDb, closeSharedTestDb } from './shared';
import { encrypt } from '../../src/integrations/crypto';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { PgEntityResolver } from '../../src/ai/resolution/pg-entity-resolver';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgUserRepository } from '../../src/users/pg-user';
import type { LLMGateway, LLMRequest, LLMResponse } from '../../src/ai/gateway/gateway';

const ENCRYPTION_KEY = 'b'.repeat(64);
const PUBLIC_API_URL = 'http://127.0.0.1:3998';

const RUN = crypto.randomInt(100000, 999999);
const A_DID = `+1512${RUN}1`;
const B_DID = `+1512${RUN}2`;
const A_SUBACCOUNT = 'AC1118aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B_SUBACCOUNT = 'AC1118bbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const DEPLOYMENT_SUBACCOUNT = 'AC11180000000000000000000000000000';
const A_TOKEN = 'tenant-a-twilio-auth-token-1118';
const B_TOKEN = 'tenant-b-twilio-auth-token-1118';
const DEPLOYMENT_TOKEN = 'deployment-master-twilio-auth-token-1118';
const A_OWNER_PHONE = `+1512${RUN}7`;
const B_OWNER_PHONE = `+1512${RUN}8`;

const FIRST = 'Jamie';
const LAST = 'Rivera';
const BOOKING_UTTERANCE = `Open a job for ${FIRST} ${LAST}, leaking faucet repair`;
const FOLLOW_UP = 'The one on 12 Oak Street';

/** renderDisambiguation's line for identically-named candidates (tts-copy.ts). */
const ASK_FOR_ADDRESS = 'more than one record under that name';
/** expandIntentConfirmTemplate's create_job readback. */
const CREATE_JOB_READBACK = 'Just to confirm — create job. Is that right?';

interface TenantFixture {
  tenantId: string;
  userId: string;
  did: string;
  subaccountSid: string;
  authToken: string;
  ownerPhone: string;
}

describe('#1118 — the phone asks when two customers share a name (real Postgres)', () => {
  let pool: Pool;
  let app: Express;
  let gracefulDrain: ((reason: string) => Promise<void>) | undefined;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;
  /** Tenant A's two same-named customers. */
  let aOak: string;
  let aPine: string;
  /** Tenant B's own same-named customer, at the SAME street as `aOak`. */
  let bOak: string;
  const savedEnv: Record<string, string | undefined> = {};

  function setEnv(key: string, value: string): void {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key];
    process.env[key] = value;
  }

  async function provision(opts: {
    did: string;
    subaccountSid: string;
    authToken: string;
    ownerPhone: string;
  }): Promise<TenantFixture> {
    const tenantId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const email = `owner+${tenantId.slice(0, 8)}@example.com`;
    await pool.query(
      `INSERT INTO tenants (id, owner_id, owner_email, name, subscription_status)
       VALUES ($1, $2, $3, $4, 'active')`,
      [tenantId, userId, email, '1118 Disambiguation Shop'],
    );
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, first_name, last_name)
       VALUES ($1, $2, $3, $4, 'owner', 'Dev', 'Owner')`,
      [userId, tenantId, userId, email],
    );
    await pool.query(
      `INSERT INTO tenant_settings
         (id, tenant_id, business_name, timezone, region, voice_agent_live_at, owner_phone, e1_reviewed_script)
       VALUES ($1, $2, '1118 Disambiguation Shop', 'America/Chicago', 'TX', NOW(), $3,
               'If this is an emergency, hang up and call 911.')`,
      [crypto.randomUUID(), tenantId, opts.ownerPhone],
    );
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
      await client.query(
        `INSERT INTO tenant_integrations
           (tenant_id, provider, status, provider_data, subaccount_sid, auth_token_primary_enc)
         VALUES ($1, 'twilio', 'full_readiness', $2::jsonb, $3, $4)`,
        [
          tenantId,
          JSON.stringify({ phoneE164: opts.did }),
          opts.subaccountSid,
          encrypt(opts.authToken, ENCRYPTION_KEY),
        ],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    return { tenantId, userId, ...opts };
  }

  async function seedCustomer(
    t: TenantFixture,
    phone: string,
    street1: string,
  ): Promise<string> {
    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: t.tenantId,
      firstName: FIRST,
      lastName: LAST,
      displayName: `${FIRST} ${LAST}`,
      primaryPhone: phone,
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await locationRepo.create({
      id: crypto.randomUUID(),
      tenantId: t.tenantId,
      customerId,
      street1,
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      addressType: 'service',
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return customerId;
  }

  function signedPost(path: string, params: Record<string, string>, authToken: string) {
    const signature = twilio.getExpectedTwilioSignature(
      authToken,
      `${PUBLIC_API_URL}${path}`,
      params,
    );
    return request(app)
      .post(path)
      .set('X-Twilio-Signature', signature)
      .type('form')
      .send(params);
  }

  function sessionIdFromTwiml(twiml: string): string {
    const m = /[?&]sid=([0-9a-f-]{36})/i.exec(twiml);
    expect(m, `no ?sid= in TwiML: ${twiml}`).not.toBeNull();
    return m![1]!;
  }

  /** One signed Gather turn on an owner-line call. Returns the TwiML. */
  async function gatherTurn(
    t: TenantFixture,
    callSid: string,
    sid: string,
    speech: string,
  ): Promise<string> {
    const res = await signedPost(
      `/api/telephony/gather?sid=${sid}`,
      {
        CallSid: callSid,
        AccountSid: t.subaccountSid,
        From: t.ownerPhone,
        To: t.did,
        SpeechResult: speech,
        Confidence: '0.95',
      },
      t.authToken,
    );
    expect(res.status).toBe(200);
    return res.text;
  }

  /** /voice → identify turn → the booking utterance, on the tenant's owner line. */
  async function ownerCallToBooking(
    t: TenantFixture,
    callSid: string,
  ): Promise<{ sid: string; bookingTwiml: string }> {
    const voice = await signedPost(
      '/api/telephony/voice',
      { CallSid: callSid, AccountSid: t.subaccountSid, From: t.ownerPhone, To: t.did },
      t.authToken,
    );
    expect(voice.status).toBe(200);
    const sid = sessionIdFromTwiml(voice.text);
    await gatherTurn(t, callSid, sid, 'This is the owner calling');
    const bookingTwiml = await gatherTurn(t, callSid, sid, BOOKING_UTTERANCE);
    return { sid, bookingTwiml };
  }

  /** audit_events for one voice session, polled — the audit write can trail the response. */
  async function sessionAudits(
    tenantId: string,
    sessionId: string,
    eventType: string,
    minRows = 1,
  ): Promise<Array<{ metadata: Record<string, unknown> }>> {
    const deadline = Date.now() + 2000;
    for (;;) {
      const { rows } = await pool.query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM audit_events
          WHERE tenant_id = $1 AND entity_id = $2 AND event_type = $3
          ORDER BY created_at`,
        [tenantId, sessionId, eventType],
      );
      if (rows.length >= minRows || Date.now() > deadline) return rows;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);

    tenantA = await provision({
      did: A_DID,
      subaccountSid: A_SUBACCOUNT,
      authToken: A_TOKEN,
      ownerPhone: A_OWNER_PHONE,
    });
    tenantB = await provision({
      did: B_DID,
      subaccountSid: B_SUBACCOUNT,
      authToken: B_TOKEN,
      ownerPhone: B_OWNER_PHONE,
    });

    aOak = await seedCustomer(tenantA, '+15125550131', '12 Oak Street');
    aPine = await seedCustomer(tenantA, '+15125550177', '48 Pine Avenue');
    bOak = await seedCustomer(tenantB, '+15125550199', '12 Oak Street');

    setEnv('NODE_ENV', 'test');
    setEnv('DATABASE_URL', process.env.TEST_DB_URL!);
    setEnv('DB_SSL', 'false');
    setEnv('PROCESS_ROLE', 'web');
    setEnv('TENANT_ENCRYPTION_KEY', ENCRYPTION_KEY);
    setEnv('PUBLIC_API_URL', PUBLIC_API_URL);
    setEnv('TWILIO_ACCOUNT_SID', DEPLOYMENT_SUBACCOUNT);
    setEnv('TWILIO_AUTH_TOKEN', DEPLOYMENT_TOKEN);
    setEnv('TWILIO_FROM_NUMBER', '+15125550000');
    setEnv('TWILIO_DEFAULT_TENANT_ID', tenantA.tenantId);
    // Gather is the transport under test here; media streams is covered by
    // the processor's unit harness (test/ai/voice-turn/speechturn-entity-ambiguous.test.ts).
    setEnv('TWILIO_MEDIA_STREAMS_ENABLED', 'false');

    const { createApp } = await import('../../src/app');
    const built = createApp();
    app = built;
    gracefulDrain = built.gracefulDrain;
  });

  afterAll(async () => {
    await gracefulDrain?.('test-teardown').catch(() => undefined);
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await closeSharedTestDb();
  });

  it('premise: Postgres itself reports tenant A\'s two "Jamie Rivera" rows as ambiguous, and tenant B\'s one as its own', async () => {
    const resolver = new PgEntityResolver(pool);
    const a = await resolver.resolve({ tenantId: tenantA.tenantId, reference: `${FIRST} ${LAST}`, kind: 'customer' });
    expect(a.kind).toBe('ambiguous');
    if (a.kind === 'ambiguous') {
      expect(a.candidates.map((c) => c.id).sort()).toEqual([aOak, aPine].sort());
    }
    const b = await resolver.resolve({ tenantId: tenantB.tenantId, reference: `${FIRST} ${LAST}`, kind: 'customer' });
    expect(b.kind).toBe('resolved');
    if (b.kind === 'resolved') expect(b.candidate.id).toBe(bOak);
  });

  it('A1 signed Gather: the booking turn ASKS (TwiML <Say>) instead of reading back create_job, and the entity_ambiguous audit names exactly tenant A\'s two candidates', async () => {
    const callSid = `CA-1118-a1-${crypto.randomUUID().slice(0, 8)}`;
    const { sid, bookingTwiml } = await ownerCallToBooking(tenantA, callSid);

    expect(bookingTwiml).toContain('<Say');
    expect(bookingTwiml).toContain(ASK_FOR_ADDRESS);
    expect(bookingTwiml).not.toContain('Is that right?');

    const ambiguous = await sessionAudits(
      tenantA.tenantId,
      sid,
      'agent.calling.entity_resolution.entity_ambiguous',
    );
    expect(ambiguous).toHaveLength(1);
    // Two, not three: tenant B's same-named, same-street customer is not a candidate.
    expect(ambiguous[0]!.metadata.candidateCount).toBe(2);

    // Nothing was drafted on a guess.
    const { rows } = await pool.query(`SELECT id FROM proposals WHERE tenant_id = $1`, [tenantA.tenantId]);
    expect(rows).toHaveLength(0);
  });

  it('A2 signed Gather: the caller\'s "the one on 12 Oak Street" follow-up resolves — the call moves on to the create_job readback instead of asking again', async () => {
    const callSid = `CA-1118-a2-${crypto.randomUUID().slice(0, 8)}`;
    const { sid, bookingTwiml } = await ownerCallToBooking(tenantA, callSid);
    expect(bookingTwiml).toContain(ASK_FOR_ADDRESS);

    const followUpTwiml = await gatherTurn(tenantA, callSid, sid, FOLLOW_UP);
    expect(followUpTwiml).toContain(CREATE_JOB_READBACK);
    expect(followUpTwiml).not.toContain(ASK_FOR_ADDRESS);

    const resolved = await sessionAudits(
      tenantA.tenantId,
      sid,
      'agent.calling.entity_resolution.entity_resolved',
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.metadata.toState).toBe('intent_confirm');
    // Exactly one question was asked on this call — the follow-up did not re-ask.
    expect(
      await sessionAudits(tenantA.tenantId, sid, 'agent.calling.entity_resolution.entity_ambiguous'),
    ).toHaveLength(1);
  });

  it('T1 signed Gather: tenant B\'s own call (one "Jamie Rivera") is never asked and never sees tenant A\'s rows', async () => {
    const callSid = `CA-1118-b-${crypto.randomUUID().slice(0, 8)}`;
    const { sid, bookingTwiml } = await ownerCallToBooking(tenantB, callSid);
    expect(bookingTwiml).toContain(CREATE_JOB_READBACK);
    expect(bookingTwiml).not.toContain(ASK_FOR_ADDRESS);
    expect(
      await sessionAudits(tenantB.tenantId, sid, 'agent.calling.entity_resolution.entity_ambiguous', 0),
    ).toHaveLength(0);
    // Tenant A's disambiguation audits never landed under tenant B.
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND event_type = 'agent.calling.entity_resolution.entity_ambiguous'`,
      [tenantB.tenantId],
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });

  describe('B — handleGather over real Pg repositories: the follow-up resolves to the RIGHT customer and the proposal carries it', () => {
    /** The only model call on this path is confirmIntent's yes/no. */
    function confirmYesGateway(): LLMGateway {
      return {
        complete: vi.fn(async (req: LLMRequest): Promise<LLMResponse> => ({
          content:
            (req.metadata as { skill?: string } | undefined)?.skill === 'confirm_intent'
              ? JSON.stringify({ answer: 'yes', reasoning: 'clear affirmative' })
              : JSON.stringify({ intentType: 'unknown', confidence: 0.2 }),
          model: 'stub',
          provider: 'stub',
          tokenUsage: { input: 1, output: 1, total: 2 },
          latencyMs: 1,
        })),
      } as unknown as LLMGateway;
    }

    function buildAdapter(store: VoiceSessionStore): TwilioGatherAdapter {
      return new TwilioGatherAdapter({
        store,
        gateway: confirmYesGateway(),
        businessName: '1118 Disambiguation Shop',
        publicBaseUrl: 'https://example.com',
        pool,
        settingsRepo: new PgSettingsRepository(pool),
        userRepo: new PgUserRepository(pool),
        customerRepo,
        proposalRepo: new PgProposalRepository(pool),
        auditRepo: new PgAuditRepository(pool),
        // Production wiring (app.ts): the shared resolver + the location repo
        // the U3 address hint reads.
        entityResolver: new PgEntityResolver(pool),
        locationRepo,
      });
    }

    async function ownerTurns(
      adapter: TwilioGatherAdapter,
      store: VoiceSessionStore,
      t: TenantFixture,
      utterances: string[],
    ): Promise<{ sessionId: string; twimls: string[] }> {
      const callSid = `CA-1118-b-${crypto.randomUUID().slice(0, 8)}`;
      await adapter.handleInbound({ callSid, from: t.ownerPhone, to: t.did, tenantId: t.tenantId });
      const session = store.findByCallSid(callSid)!;
      const twimls: string[] = [];
      for (const speechResult of utterances) {
        twimls.push(
          await adapter.handleGather({
            sessionId: session.id,
            callSid,
            speechResult,
            confidence: 0.95,
            tenantId: t.tenantId,
          }),
        );
      }
      return { sessionId: session.id, twimls };
    }

    it('B1 ask → "the one on 12 Oak Street" → "yes": the create_job proposal row carries the 12 Oak Street customer, and tenant B is untouched', async () => {
      const store = new VoiceSessionStore({ startInterval: false });
      const adapter = buildAdapter(store);
      const proposalsBeforeB = (
        await pool.query(`SELECT id FROM proposals WHERE tenant_id = $1`, [tenantB.tenantId])
      ).rows.length;

      const { sessionId, twimls } = await ownerTurns(adapter, store, tenantA, [
        'This is the owner calling',
        BOOKING_UTTERANCE,
      ]);
      const session = store.get(sessionId)!;

      // The ask, with the in-app adapter's exact pending shape — tenant A's two
      // ids only, each carrying the address the follow-up is matched against.
      expect(twimls[1]).toContain(ASK_FOR_ADDRESS);
      expect(session.machine.currentState).toBe('entity_resolution');
      const pending = session.machine.currentContext.pendingEntityAmbiguity;
      expect(pending?.entityKind).toBe('customer');
      expect(pending?.refKey).toBe('customerId');
      expect(pending?.reference).toBe(`${FIRST} ${LAST}`);
      expect(pending?.candidates.map((c) => c.id).sort()).toEqual([aOak, aPine].sort());
      expect(pending?.candidates.map((c) => c.id)).not.toContain(bOak);
      expect(pending?.candidates.find((c) => c.id === aOak)?.hint).toContain('12 Oak Street');

      // The follow-up resolves to the Oak Street customer.
      const followUp = await adapter.handleGather({
        sessionId,
        callSid: session.callSid!,
        speechResult: FOLLOW_UP,
        confidence: 0.95,
        tenantId: tenantA.tenantId,
      });
      expect(followUp).toContain(CREATE_JOB_READBACK);
      expect(session.machine.currentState).toBe('intent_confirm');
      expect(session.machine.currentContext.extractedEntities?.customerId).toBe(aOak);
      expect(session.machine.currentContext.pendingEntityAmbiguity).toBeUndefined();

      // A real "yes" drafts the proposal — with the right customer on it.
      await adapter.handleGather({
        sessionId,
        callSid: session.callSid!,
        speechResult: 'yes',
        confidence: 0.95,
        tenantId: tenantA.tenantId,
      });
      const { rows } = await pool.query<{ proposal_type: string; payload: Record<string, unknown> }>(
        // Tenant A's only proposal: A1/A2 above drafted nothing (A1 pins it).
        `SELECT proposal_type, payload FROM proposals WHERE tenant_id = $1`,
        [tenantA.tenantId],
      );
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows[0]!.payload)).toContain(aOak);
      expect(JSON.stringify(rows[0]!.payload)).not.toContain(aPine);

      // T1 — tenant B: no proposal, no disambiguation audit.
      expect(
        (await pool.query(`SELECT id FROM proposals WHERE tenant_id = $1`, [tenantB.tenantId])).rows.length,
      ).toBe(proposalsBeforeB);
    });
  });
});

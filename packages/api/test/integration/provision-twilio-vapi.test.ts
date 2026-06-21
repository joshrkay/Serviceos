/**
 * Docker-gated integration test — NOT run in web sessions. Requires the
 * testcontainer Postgres started by `npm run test:integration`.
 *
 * Voice-parity (Feature 4 / tracker gap H1): proves the voice-agent creation
 * SQL in provision-twilio Step 4.5 works against the REAL schema.
 *
 * The unit tests (test/workers/provision-twilio.test.ts) prove Step 4.5's
 * orchestration against a mocked pool — but a mocked Pool will happily accept
 * a wrong column name (the entity-resolver "nonexistent columns" lesson in
 * CLAUDE.md). This file runs the production worker against real Postgres so the
 * actual statements are pinned to the live `tenant_settings` columns:
 *   - the SELECT of business_name, voice_greeting, voice_id, services_offered,
 *     vapi_assistant_id,
 *   - the UPDATE that persists vapi_assistant_id,
 *   - the tenant_integrations provider_data writes + active transition.
 * Twilio HTTP is stubbed (global fetch) and the Vapi client is injected; only
 * the DB is real.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';
import {
  createProvisionTwilioWorker,
  PROVISION_TWILIO_JOB_TYPE,
  type ProvisionTwilioPayload,
} from '../../src/workers/provision-twilio';
import type { VapiClient } from '../../src/integrations/vapi/client';
import type { VapiAssistantConfig } from '../../src/integrations/vapi/assistant-config';
import { createLogger } from '../../src/logging/logger';
import { QueueMessage } from '../../src/queues/queue';

const KEY = 'a'.repeat(64); // 64-char hex = 32 bytes (TENANT_ENCRYPTION_KEY format)
const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

function buildMessage(payload: ProvisionTwilioPayload): QueueMessage<ProvisionTwilioPayload> {
  return {
    id: 'msg-int-1',
    type: PROVISION_TWILIO_JOB_TYPE,
    payload,
    attempts: 1,
    maxAttempts: 3,
    idempotencyKey: `provision-twilio-${payload.tenantId}`,
    createdAt: new Date().toISOString(),
  };
}

/** The five Twilio HTTP responses for a full provision through "attach". */
function stubTwilioFetch(): void {
  const fn = vi.fn();
  const bodies: unknown[] = [
    { sid: 'ACsub', auth_token: 'subtoken' }, // create subaccount
    { sid: 'MG123' }, // messaging service
    { incoming_phone_numbers: [] }, // list owned (none yet)
    { sid: 'PN555', phone_number: '+15125550123' }, // purchase preferred
    {}, // attach to messaging service
  ];
  for (const body of bodies) {
    fn.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
  }
  vi.stubGlobal('fetch', fn);
}

function makeVapiMock() {
  const createAssistant = vi.fn((_config: VapiAssistantConfig) =>
    Promise.resolve({ assistantId: 'asst_int_123' }),
  );
  const linkPhoneNumber = vi.fn(() => Promise.resolve({ phoneNumberId: 'pn_int_1' }));
  const updateAssistant = vi.fn(() => Promise.resolve());
  const client = { createAssistant, linkPhoneNumber, updateAssistant } as unknown as VapiClient;
  return { client, createAssistant, linkPhoneNumber };
}

async function seedSettings(
  pool: Pool,
  tenantId: string,
  overrides: { businessName?: string; greeting?: string | null; voiceId?: string; services?: string[] } = {},
): Promise<void> {
  await pool.query(
    `INSERT INTO tenant_settings (id, tenant_id, business_name, voice_greeting, voice_id, services_offered)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::text[])`,
    [
      tenantId,
      overrides.businessName ?? "Bob's Plumbing",
      overrides.greeting ?? null,
      overrides.voiceId ?? 'adam',
      overrides.services ?? ['drain cleaning', 'water heaters'],
    ],
  );
}

describe('Postgres integration — provision-twilio Vapi assistant (voice agent) creation', () => {
  let pool: Pool;
  const restore: Array<[string, string | undefined]> = [];

  function setEnv(k: string, v: string | undefined): void {
    restore.push([k, process.env[k]]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
  });
  afterAll(async () => {
    await closeSharedTestDb();
  });

  beforeEach(() => {
    setEnv('TWILIO_ACCOUNT_SID', 'ACmaster');
    setEnv('TWILIO_AUTH_TOKEN', 'mastertoken');
    setEnv('TENANT_ENCRYPTION_KEY', KEY);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    while (restore.length) {
      const [k, v] = restore.pop()!;
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('creates + links the assistant and persists vapi_assistant_id (real columns)', async () => {
    const { tenantId } = await createTestTenant(pool);
    await seedSettings(pool, tenantId);
    stubTwilioFetch();
    const vapi = makeVapiMock();
    const worker = createProvisionTwilioWorker({ pool, vapiClient: vapi.client });

    await worker.handle(
      buildMessage({ tenantId, region: null, baseUrl: 'https://api.test', phoneNumber: '+15125550123' }),
      logger,
    );

    // The assistant was built from the SEEDED voice config — proving the
    // Step 4.5 SELECT read the real columns (adam preset, services greeting).
    expect(vapi.createAssistant).toHaveBeenCalledTimes(1);
    const cfg = vapi.createAssistant.mock.calls[0][0];
    expect(cfg.voiceId).toBe('pNInz6obpgDQGcFmaJgB'); // adam → ElevenLabs id
    expect(cfg.firstMessage).toContain('drain cleaning');
    expect(vapi.linkPhoneNumber).toHaveBeenCalledWith(
      expect.objectContaining({ assistantId: 'asst_int_123', phoneE164: '+15125550123' }),
    );

    // Pinned against real Postgres: the assistant id landed on tenant_settings…
    const s = await pool.query<{ vapi_assistant_id: string | null; business_phone: string | null }>(
      `SELECT vapi_assistant_id, business_phone FROM tenant_settings WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(s.rows[0].vapi_assistant_id).toBe('asst_int_123');
    expect(s.rows[0].business_phone).toBe('+15125550123');

    // …and tenant_integrations reached active with the ids in provider_data.
    const ti = await pool.query<{ status: string; provider_data: { vapiAssistantId?: string; phoneE164?: string } }>(
      `SELECT status, provider_data FROM tenant_integrations WHERE tenant_id = $1 AND provider = 'twilio'`,
      [tenantId],
    );
    expect(ti.rows[0].status).toBe('full_readiness');
    expect(ti.rows[0].provider_data.vapiAssistantId).toBe('asst_int_123');
    expect(ti.rows[0].provider_data.phoneE164).toBe('+15125550123');
  });

  it('is idempotent: an existing vapi_assistant_id is not overwritten', async () => {
    const { tenantId } = await createTestTenant(pool);
    await seedSettings(pool, tenantId);
    await pool.query(
      `UPDATE tenant_settings SET vapi_assistant_id = 'asst_existing' WHERE tenant_id = $1`,
      [tenantId],
    );
    stubTwilioFetch();
    const vapi = makeVapiMock();
    const worker = createProvisionTwilioWorker({ pool, vapiClient: vapi.client });

    await worker.handle(
      buildMessage({ tenantId, region: null, baseUrl: 'https://api.test', phoneNumber: '+15125550123' }),
      logger,
    );

    expect(vapi.createAssistant).not.toHaveBeenCalled();
    const s = await pool.query<{ vapi_assistant_id: string | null }>(
      `SELECT vapi_assistant_id FROM tenant_settings WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(s.rows[0].vapi_assistant_id).toBe('asst_existing');
    // Twilio readiness is independent of the (skipped) Vapi step.
    const ti = await pool.query<{ status: string }>(
      `SELECT status FROM tenant_integrations WHERE tenant_id = $1 AND provider = 'twilio'`,
      [tenantId],
    );
    expect(ti.rows[0].status).toBe('full_readiness');
  });
});

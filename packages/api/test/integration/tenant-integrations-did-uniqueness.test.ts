/**
 * Docker-gated integration test for #1061 — one tenant per DID.
 *
 * `tenant_integrations.provider_data->>'phoneE164'` had no uniqueness
 * constraint, so two tenants could each be provisioned with the SAME Twilio
 * DID. Three call sites then become a `LIMIT 1` coin-flip over the duplicate
 * rows, with no ORDER BY to even make the flip deterministic:
 *
 *   - `PgPhoneNumberRepository.findByNumber` (integrations/twilio/phone-number-repository.ts)
 *   - `resolveTenantIdByPhoneNumber` (app.ts) — inbound `/voice` + `/gather` routing
 *   - tenant credential selection (integrations/credentials.ts), since PR #1082
 *
 * An inbound call to a shared DID therefore lands in an arbitrary tenant, and
 * the reply goes out on an arbitrary tenant's credentials.
 *
 * The guarantee has to live in the database: every writer above resolves the
 * tenant FROM the DID, so there is no tenant scope inside which application
 * code could check for a conflict.
 *
 * RED: the first test inserts two twilio rows, for two different tenants,
 * carrying the same phoneE164, and expects the second insert to be refused
 * with a unique violation (23505). Before migration 274 both inserts succeed
 * — that success IS the bug.
 *
 * Note the rows must belong to two DIFFERENT tenants: migration 070 already
 * carries `UNIQUE (tenant_id, provider)`, so one tenant cannot hold two twilio
 * rows. Cross-tenant duplication is both the only reachable shape and exactly
 * the production incident this issue describes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, DatabaseError } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';

/**
 * The shared DID both tenants claim, and its non-colliding sibling below.
 *
 * Both come from the `+1512555990x` block, which no other test or source file
 * uses. That matters now: migration 274 makes a twilio DID unique ACROSS
 * tenants and the integration suite shares one database, so any two files
 * reusing a literal collide. `+15125550200` was this file's original sibling
 * DID and collides with `voice-inbound-appointment.test.ts`'s `DID_B`.
 */
const SHARED_DID = '+15125559902';
const OTHER_DID = '+15125559903';

/**
 * Insert a twilio integration row under the tenant's own RLS context, the way
 * the provisioning worker does (`tenantQuery` in workers/provision-twilio.ts).
 */
async function insertTwilioIntegration(
  pool: Pool,
  tenantId: string,
  providerData: Record<string, unknown>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_tenant_id = '${tenantId}'`);
    await client.query(
      `INSERT INTO tenant_integrations (tenant_id, provider, status, provider_data)
       VALUES ($1, 'twilio', 'full_readiness', $2::jsonb)`,
      [tenantId, JSON.stringify(providerData)],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    try {
      await client.query('RESET app.current_tenant_id');
    } catch {
      /* best effort */
    }
    client.release();
  }
}

describe('Postgres integration — one tenant per DID (#1061)', () => {
  let pool: Pool;
  let tenantA: { tenantId: string; userId: string };
  let tenantB: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('refuses a second tenant claiming the same phoneE164 (unique violation)', async () => {
    await insertTwilioIntegration(pool, tenantA.tenantId, { phoneE164: SHARED_DID });

    await expect(
      insertTwilioIntegration(pool, tenantB.tenantId, { phoneE164: SHARED_DID }),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('leaves exactly one row holding the DID, so the LIMIT 1 lookup is deterministic', async () => {
    const { rows } = await pool.query(
      `SELECT tenant_id FROM tenant_integrations
        WHERE provider = 'twilio' AND provider_data->>'phoneE164' = $1`,
      [SHARED_DID],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBe(tenantA.tenantId);
  });

  it('still allows a different tenant to hold a different DID', async () => {
    // A fresh tenant, not tenantB: whether tenantB already owns a row depends
    // on whether the migration is in force, and migration 070's
    // UNIQUE (tenant_id, provider) would then mask the assertion.
    const t = await createTestTenant(pool);
    await expect(
      insertTwilioIntegration(pool, t.tenantId, { phoneE164: OTHER_DID }),
    ).resolves.toBeUndefined();
  });

  it('still allows many tenants with no phoneE164 yet (partial index skips NULLs)', async () => {
    // Provisioning inserts the row first and fills phoneE164 in later, so
    // mid-provision rows must not collide with each other.
    const t = await createTestTenant(pool);
    await expect(
      insertTwilioIntegration(pool, t.tenantId, { messagingServiceSid: 'MG1' }),
    ).resolves.toBeUndefined();

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM tenant_integrations
        WHERE provider = 'twilio' AND provider_data->>'phoneE164' IS NULL`,
    );
    expect(rows[0].n).toBeGreaterThanOrEqual(1);
  });

  /**
   * Josh's verification gate on PR #1120 ran the pre-flight against a
   * container and got `+15005550006 × 4` — magic-test-number rows carrying NO
   * `stub: true` marker. `public-intake.test.ts` names that shape outright
   * ("rows predating it"), so production may hold several, and under a
   * stub-marker-only predicate the CREATE INDEX would fail and block a deploy.
   *
   * The exchange, not the marker, is what makes a number un-routable:
   * `isTwilioTestNumber` (telephony/phone-policy.ts) treats all of
   * `+1500555xxxx` as test-only because 500-555 is not an assignable NANP
   * block — "there is no legitimate tenant line to false-positive on". So
   * uniqueness over those numbers protects nothing, and the index matches
   * that predicate instead.
   */
  it('allows legacy magic-number rows with NO stub marker to coexist', async () => {
    const legacy = { phoneE164: '+15005550006' }; // no `stub` key at all
    const t1 = await createTestTenant(pool);
    const t2 = await createTestTenant(pool);

    await expect(insertTwilioIntegration(pool, t1.tenantId, legacy)).resolves.toBeUndefined();
    await expect(insertTwilioIntegration(pool, t2.tenantId, legacy)).resolves.toBeUndefined();
  });

  it('covers the whole +1500555xxxx test exchange, not just the one stub number', async () => {
    const other = { phoneE164: '+15005550001' };
    const t1 = await createTestTenant(pool);
    const t2 = await createTestTenant(pool);

    await expect(insertTwilioIntegration(pool, t1.tenantId, other)).resolves.toBeUndefined();
    await expect(insertTwilioIntegration(pool, t2.tenantId, other)).resolves.toBeUndefined();
  });

  it('a number outside that exchange is still constrained, marker or not', async () => {
    // The carve-out must not become a way to smuggle a real duplicate past
    // the index by setting `stub: true` on a dialable number.
    const real = { phoneE164: '+15125559904', stub: true };
    const t1 = await createTestTenant(pool);
    const t2 = await createTestTenant(pool);

    await insertTwilioIntegration(pool, t1.tenantId, real);
    await expect(insertTwilioIntegration(pool, t2.tenantId, real)).rejects.toMatchObject({
      code: '23505',
    });
  });

  it('still allows every dev tenant to share the Twilio magic stub number', async () => {
    // workers/provision-twilio.ts assigns the SAME magic test number
    // (+15005550006, tagged `stub: true`) to every tenant provisioned without
    // real Twilio creds. Those rows are not dialable and never route a real
    // inbound call, so the index must exclude them or dev/CI onboarding breaks
    // for the second tenant onward. See the lane report, §4.
    const stub = { phoneE164: '+15005550006', stub: true };
    const t1 = await createTestTenant(pool);
    const t2 = await createTestTenant(pool);

    await expect(insertTwilioIntegration(pool, t1.tenantId, stub)).resolves.toBeUndefined();
    await expect(insertTwilioIntegration(pool, t2.tenantId, stub)).resolves.toBeUndefined();
  });

  it('the index exists, is UNIQUE, and is partial', async () => {
    const { rows } = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'tenant_integrations'
          AND indexname = 'uq_tenant_integrations_twilio_phone_e164'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toContain('CREATE UNIQUE INDEX');
    expect(rows[0].indexdef).toContain('WHERE');
  });

  it('surfaces as a DatabaseError with the constraint name, so callers can classify it', async () => {
    const t = await createTestTenant(pool);
    const err = await insertTwilioIntegration(pool, t.tenantId, {
      phoneE164: SHARED_DID,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(DatabaseError);
    expect((err as DatabaseError).code).toBe('23505');
    expect((err as DatabaseError).constraint).toBe('uq_tenant_integrations_twilio_phone_e164');
  });
});

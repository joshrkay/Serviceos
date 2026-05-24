import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createLogger } from '../../src/logging/logger';
import { deprovisionTenant } from '../../src/tenants/deprovision';

// The stored Twilio auth token is decrypted before the release call; stub it
// so the test fixtures don't need real ciphertext.
vi.mock('../../src/integrations/crypto', () => ({
  decrypt: vi.fn(() => 'subtoken'),
  encrypt: vi.fn(() => 'enc'),
}));

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });
const TENANT = '00000000-0000-0000-0000-000000000001';

interface MockOpts {
  tenantExists: boolean;
  twilioRow?: {
    subaccount_sid: string | null;
    auth_token_primary_enc: string | null;
    provider_data: { phoneNumberSid?: string } | null;
  } | null;
  tables?: string[];
}

interface MockPool {
  query: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  logInserts: Array<{ sql: string; params: unknown[] }>;
  deletes: string[];
}

function createMockPool(opts: MockOpts): MockPool {
  const logInserts: Array<{ sql: string; params: unknown[] }> = [];
  const deletes: string[] = [];
  const tables = opts.tables ?? ['customers', 'jobs', 'tenant_settings'];

  const route = async (sql: string, params: unknown[] = []) => {
    if (/SELECT id FROM tenants WHERE id/.test(sql)) {
      return { rowCount: opts.tenantExists ? 1 : 0, rows: opts.tenantExists ? [{ id: TENANT }] : [] };
    }
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql) || /set_config|SET LOCAL/.test(sql)) {
      return { rowCount: 0, rows: [] };
    }
    if (/SELECT subaccount_sid/.test(sql)) {
      const row = opts.twilioRow;
      return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
    }
    if (/information_schema\.columns/.test(sql)) {
      return { rowCount: tables.length, rows: tables.map((t) => ({ table_name: t })) };
    }
    const delMatch = sql.match(/DELETE FROM "([^"]+)"/);
    if (delMatch) {
      deletes.push(delMatch[1]);
      return { rowCount: 2, rows: [] };
    }
    if (/DELETE FROM tenants WHERE id/.test(sql)) {
      return { rowCount: 1, rows: [] };
    }
    if (/INSERT INTO platform_deprovision_log/.test(sql)) {
      logInserts.push({ sql, params });
      return { rowCount: 1, rows: [] };
    }
    return { rowCount: 0, rows: [] };
  };

  const query = vi.fn(route);
  const connect = vi.fn(async () => ({ query: vi.fn(route), release: vi.fn() }));
  return { query, connect, logInserts, deletes };
}

function twilioMock() {
  return {
    releasePhoneNumber: vi.fn(async () => undefined),
    closeSubaccount: vi.fn(async () => undefined),
  };
}

describe('deprovisionTenant', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env.TENANT_ENCRYPTION_KEY = 'a'.repeat(64);
    process.env.TWILIO_ACCOUNT_SID = 'ACmaster';
    process.env.TWILIO_AUTH_TOKEN = 'mastertoken';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it('is a no-op when the tenant is already gone (idempotent)', async () => {
    const pool = createMockPool({ tenantExists: false });
    const result = await deprovisionTenant(
      { pool: pool as never, logger, twilio: twilioMock() },
      { tenantId: TENANT, reason: 'manual_admin', actorId: 'admin-1' },
    );
    expect(result.alreadyPurged).toBe(true);
    expect(pool.deletes).toEqual([]);
    expect(pool.logInserts).toHaveLength(0);
  });

  it('rejects an invalid tenant id', async () => {
    const pool = createMockPool({ tenantExists: true });
    await expect(
      deprovisionTenant(
        { pool: pool as never, logger, twilio: twilioMock() },
        { tenantId: 'not-a-uuid', reason: 'manual_admin', actorId: 'admin-1' },
      ),
    ).rejects.toThrow(/Invalid tenant ID/);
  });

  it('releases Twilio, purges every tenant table + tenants, and writes a surviving log row', async () => {
    const pool = createMockPool({
      tenantExists: true,
      twilioRow: {
        subaccount_sid: 'ACsub',
        auth_token_primary_enc: 'deadbeef',
        provider_data: { phoneNumberSid: 'PNabc' },
      },
      tables: ['customers', 'jobs', 'tenant_settings', 'tenant_integrations'],
    });
    const twilio = twilioMock();
    // decrypt() is called on the stored token — stub it via the crypto module.

    const result = await deprovisionTenant(
      { pool: pool as never, logger, twilio },
      { tenantId: TENANT, reason: 'manual_admin', actorId: 'admin-1' },
    );

    expect(result.alreadyPurged).toBe(false);
    expect(result.twilioReleased).toBe(true);
    expect(twilio.releasePhoneNumber).toHaveBeenCalledWith('ACsub', 'subtoken', 'PNabc');
    expect(twilio.closeSubaccount).toHaveBeenCalledWith('ACmaster', 'mastertoken', 'ACsub');
    // Every discovered table + tenants row purged.
    expect(pool.deletes).toEqual(['customers', 'jobs', 'tenant_settings', 'tenant_integrations']);
    expect(result.rowsDeletedByTable['tenants']).toBe(1);
    // Durable log written with twilio_released = true.
    expect(pool.logInserts).toHaveLength(1);
    expect(pool.logInserts[0].params[3]).toBe(true); // twilio_released
  });

  it('aborts before purge when Twilio release fails on the manual path (no force)', async () => {
    const pool = createMockPool({
      tenantExists: true,
      twilioRow: { subaccount_sid: 'ACsub', auth_token_primary_enc: 'x', provider_data: null },
    });
    const twilio = twilioMock();
    twilio.closeSubaccount.mockRejectedValue(new Error('twilio 500'));

    await expect(
      deprovisionTenant(
        { pool: pool as never, logger, twilio },
        { tenantId: TENANT, reason: 'manual_admin', actorId: 'admin-1' },
      ),
    ).rejects.toThrow(/Twilio release failed/);
    expect(pool.deletes).toEqual([]); // DB untouched
  });

  it('purges anyway when Twilio fails but force=true, recording the error', async () => {
    const pool = createMockPool({
      tenantExists: true,
      twilioRow: { subaccount_sid: 'ACsub', auth_token_primary_enc: 'x', provider_data: null },
    });
    const twilio = twilioMock();
    twilio.closeSubaccount.mockRejectedValue(new Error('twilio 500'));

    const result = await deprovisionTenant(
      { pool: pool as never, logger, twilio },
      { tenantId: TENANT, reason: 'manual_admin', actorId: 'admin-1', force: true },
    );

    expect(result.twilioReleased).toBe(false);
    expect(result.twilioError).toMatch(/twilio 500/);
    expect(pool.deletes.length).toBeGreaterThan(0);
    expect(pool.logInserts[0].params[3]).toBe(false); // twilio_released
    expect(pool.logInserts[0].params[5]).toMatch(/twilio 500/); // twilio_error
  });
});

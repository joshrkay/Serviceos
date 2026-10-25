import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createLogger } from '../../src/logging/logger';
import { deprovisionTenant } from '../../src/tenants/deprovision';
import { fakeTenantPool } from '../helpers/fake-tenant-pool';

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

// ─── Comms C6 — the purge deletes stored objects instead of orphaning them ───

describe('C6 stored-object cleanup', () => {
  function poolWithFiles(
    files: Array<{ s3_bucket: string; s3_key: string; thumbnail_s3_key?: string | null }>,
  ) {
    const route = async (sql: string) => {
      if (/SELECT id FROM tenants WHERE id/.test(sql)) return { rowCount: 1, rows: [{ id: TENANT }] };
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql) || /set_config|SET LOCAL/.test(sql)) {
        return { rowCount: 0, rows: [] };
      }
      if (/SELECT subaccount_sid/.test(sql)) return { rowCount: 0, rows: [] };
      if (/FROM files/.test(sql)) {
        // The harvest MUST read the thumbnail key too — an object whose only
        // pointer row is deleted in the same transaction can never be
        // rediscovered. Fail loudly here rather than silently returning rows
        // the production query didn't ask for.
        expect(sql).toMatch(/thumbnail_s3_key/);
        return { rowCount: files.length, rows: files };
      }
      if (/information_schema\.columns/.test(sql)) {
        return { rowCount: 1, rows: [{ table_name: 'files' }] };
      }
      if (/DELETE FROM/.test(sql)) return { rowCount: files.length, rows: [] };
      if (/INSERT INTO platform_deprovision_log/.test(sql)) return { rowCount: 1, rows: [] };
      return { rowCount: 0, rows: [] };
    };
    const logInserts: Array<{ params: unknown[] }> = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (/INSERT INTO platform_deprovision_log/.test(sql)) {
        logInserts.push({ params: params ?? [] });
      }
      return route(sql);
    });
    return {
      query,
      logInserts,
      connect: vi.fn(async () => ({ query: vi.fn(route), release: vi.fn() })),
    };
  }

  it('captures file keys pre-purge and deletes each object post-commit', async () => {
    const pool = poolWithFiles([
      { s3_bucket: 'bkt', s3_key: 't/rec-1.mp3' },
      { s3_bucket: 'bkt', s3_key: 't/photo-1.jpg' },
    ]);
    const deleteObject = vi.fn(async () => undefined);
    const result = await deprovisionTenant(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { pool: pool as any, logger, storage: { deleteObject } as any },
      { tenantId: TENANT, reason: 'manual_admin', actorId: 'admin-1' },
    );
    expect(deleteObject).toHaveBeenCalledTimes(2);
    expect(deleteObject).toHaveBeenCalledWith('bkt', 't/rec-1.mp3');
    expect(deleteObject).toHaveBeenCalledWith('bkt', 't/photo-1.jpg');
    expect(result.storageObjectsDeleted).toBe(2);
    expect(result.storageObjectErrors).toBe(0);
  });

  it('deletes the derived thumbnail object as well as the original', async () => {
    const pool = poolWithFiles([
      { s3_bucket: 'bkt', s3_key: 't/photo-1.jpg', thumbnail_s3_key: 't/photo-1.jpg.thumb.jpg' },
      // A row with no thumbnail (audio, documents) contributes one object only.
      { s3_bucket: 'bkt', s3_key: 't/rec-1.mp3', thumbnail_s3_key: null },
    ]);
    const deleteObject = vi.fn(async () => undefined);
    const result = await deprovisionTenant(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { pool: pool as any, logger, storage: { deleteObject } as any },
      { tenantId: TENANT, reason: 'manual_admin', actorId: 'admin-1' },
    );
    expect(deleteObject).toHaveBeenCalledWith('bkt', 't/photo-1.jpg');
    expect(deleteObject).toHaveBeenCalledWith('bkt', 't/photo-1.jpg.thumb.jpg');
    expect(deleteObject).toHaveBeenCalledWith('bkt', 't/rec-1.mp3');
    expect(deleteObject).toHaveBeenCalledTimes(3);
    expect(result.storageObjectsDeleted).toBe(3);
    expect(result.storageObjectErrors).toBe(0);
  });

  it('records the keys of objects it failed to delete in the durable log', async () => {
    const pool = poolWithFiles([{ s3_bucket: 'bkt', s3_key: 'boom.mp3' }]);
    const deleteObject = vi.fn(async () => {
      throw new Error('s3 down');
    });
    await deprovisionTenant(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { pool: pool as any, logger, storage: { deleteObject } as any },
      { tenantId: TENANT, reason: 'manual_admin', actorId: 'admin-1' },
    );
    // The files rows are already gone, so this log is the only thing that can
    // point an operator at the leftover object.
    const logged = JSON.parse(pool.logInserts[0].params[6] as string);
    expect(logged.__storage_orphans).toEqual(['bkt/boom.mp3']);
  });

  it('counts orphaned objects and continues when no storage provider is wired', async () => {
    const pool = poolWithFiles([{ s3_bucket: 'bkt', s3_key: 't/rec-2.mp3' }]);
    const result = await deprovisionTenant(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { pool: pool as any, logger },
      { tenantId: TENANT, reason: 'manual_admin', actorId: 'admin-1' },
    );
    expect(result.alreadyPurged).toBe(false);
    expect(result.storageObjectsDeleted).toBe(0);
    expect(result.storageObjectErrors).toBe(1);
  });

  it('a failed object delete is counted, logged, and non-fatal', async () => {
    const pool = poolWithFiles([
      { s3_bucket: 'bkt', s3_key: 'ok.mp3' },
      { s3_bucket: 'bkt', s3_key: 'boom.mp3' },
    ]);
    const deleteObject = vi.fn(async (_b: string, key: string) => {
      if (key === 'boom.mp3') throw new Error('s3 down');
    });
    const result = await deprovisionTenant(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { pool: pool as any, logger, storage: { deleteObject } as any },
      { tenantId: TENANT, reason: 'manual_admin', actorId: 'admin-1' },
    );
    expect(result.storageObjectsDeleted).toBe(1);
    expect(result.storageObjectErrors).toBe(1);
  });
});

// ─── Raw-pg audit 2026-10-23 §4 P2.8 — the credential read under the runtime role ───
// readTwilioIntegration set only the tenant GUC (set_config) inside its own
// BEGIN, with no role, so the tenant_integrations policy did not bind the
// principal. It now runs in a tenant session (applyTenantContext: the GUC and
// rls_app_runtime in one statement). Real Postgres:
// test/integration/deprovision-tenant-context.test.ts.

describe('deprovisionTenant — the Twilio credential read is a tenant session', () => {
  const ORIGINAL_ENV = { ...process.env };
  const CREDENTIAL = /SELECT subaccount_sid, auth_token_primary_enc, provider_data/;

  beforeEach(() => {
    process.env.RLS_RUNTIME_ROLE = 'true';
    process.env.TENANT_ENCRYPTION_KEY = 'a'.repeat(64);
    process.env.TWILIO_ACCOUNT_SID = 'ACmaster';
    process.env.TWILIO_AUTH_TOKEN = 'mastertoken';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  function credentialPool(opts: { failRead?: boolean } = {}) {
    return fakeTenantPool((sql) => {
      if (/SELECT id FROM tenants WHERE id/.test(sql)) return { rows: [{ id: TENANT }] };
      if (CREDENTIAL.test(sql)) {
        if (opts.failRead) throw new Error('credential read failed');
        return { rows: [{ subaccount_sid: 'ACsub', auth_token_primary_enc: 'enc', provider_data: { phoneNumberSid: 'PNabc' } }] };
      }
      if (/information_schema\.columns/.test(sql)) return { rows: [{ table_name: 'customers' }] };
      return undefined;
    });
  }

  it('one checkout: BEGIN, the GUC and rls_app_runtime in one statement, the read, COMMIT — before Twilio and the purge', async () => {
    const fake = credentialPool();
    const twilio = twilioMock();

    const result = await deprovisionTenant(
      { pool: fake.pool, logger, twilio },
      { tenantId: TENANT, reason: 'manual_admin', actorId: 'admin-1' },
    );

    expect(result.twilioReleased).toBe(true);
    expect(twilio.closeSubaccount).toHaveBeenCalledWith('ACmaster', 'mastertoken', 'ACsub');
    // Checkout 0 is the existence check; 1 the credential session; 2 the purge; 3 the log.
    const session = fake.statements.filter((s) => s.checkout === 1);
    expect(session.map((s) => s.sql.replace(/\s+/g, ' ').trim())).toEqual([
      'BEGIN',
      "SELECT set_config('app.current_tenant_id', $1, true), set_config('role', 'rls_app_runtime', true)",
      expect.stringMatching(CREDENTIAL),
      'COMMIT',
    ]);
    expect(session[1].values).toEqual([TENANT]);
    expect(session[2].values).toEqual([TENANT]);
    expect(fake.statements.find((s) => s.checkout === 2)?.sql).toBe('BEGIN');
    expect(fake.open()).toBe(0);
  });

  it('a failed credential read rolls back, releases the client and aborts before Twilio and the purge', async () => {
    const fake = credentialPool({ failRead: true });
    const twilio = twilioMock();

    await expect(
      deprovisionTenant(
        { pool: fake.pool, logger, twilio },
        { tenantId: TENANT, reason: 'manual_admin', actorId: 'admin-1' },
      ),
    ).rejects.toThrow('credential read failed');

    expect(fake.statements.filter((s) => s.checkout === 1).map((s) => s.sql)).toContain('ROLLBACK');
    expect(fake.checkouts()).toBe(2);
    expect(fake.open()).toBe(0);
    expect(twilio.closeSubaccount).not.toHaveBeenCalled();
    expect(fake.statements.some((s) => /DELETE FROM|platform_deprovision_log/.test(s.sql))).toBe(false);
  });
});

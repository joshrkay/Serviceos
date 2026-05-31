import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { createIntegrationResolver } from '../../src/webhooks/integration-resolver';

/**
 * Guards the malformed-tenantId path: the resolver receives `tenantId`
 * straight from a public webhook URL param, so a non-UUID value must be
 * rejected up front (return null → caller answers 403) WITHOUT acquiring a
 * pool client or reaching setTenantContext's throw.
 */
describe('createIntegrationResolver — tenant id validation', () => {
  it('returns null and never touches the pool for a non-UUID tenant id', async () => {
    const connect = vi.fn();
    const pool = { connect } as unknown as Pool;
    const resolve = createIntegrationResolver(pool);

    for (const bad of ['', 'not-a-uuid', '123', '../etc/passwd', "'; DROP TABLE x;--"]) {
      await expect(resolve(bad, 'twilio')).resolves.toBeNull();
    }
    expect(connect).not.toHaveBeenCalled();
  });

  it('proceeds to the pool for a well-formed UUID', async () => {
    // A valid UUID must get past the guard; we fail the connect immediately
    // so we don't need a full pg mock — the point is that connect() is reached.
    const connect = vi.fn().mockRejectedValue(new Error('connect reached'));
    const pool = { connect } as unknown as Pool;
    const resolve = createIntegrationResolver(pool);

    await expect(
      resolve('11111111-1111-1111-1111-111111111111', 'twilio'),
    ).rejects.toThrow('connect reached');
    expect(connect).toHaveBeenCalledTimes(1);
  });
});

import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { resolveOwnerEmail } from '../../src/auth/resolve-owner-email';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

function req(partial: Partial<AuthenticatedRequest>): AuthenticatedRequest {
  return partial as AuthenticatedRequest;
}

describe('resolveOwnerEmail', () => {
  it('prefers clerkUser.email when present', async () => {
    const email = await resolveOwnerEmail(
      req({
        clerkUser: { id: 'u1', email: 'from-jwt@example.com' },
        auth: {
          userId: 'u1',
          sessionId: 's',
          tenantId: 't1',
          role: 'owner',
        },
      }),
    );
    expect(email).toBe('from-jwt@example.com');
  });

  it('falls back to users.email then tenants.owner_email', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ email: 'owner@shop.com' }],
    });
    const pool = { query } as unknown as Pool;
    const email = await resolveOwnerEmail(
      req({
        auth: {
          userId: 'user_abc',
          sessionId: 's',
          tenantId: 'tenant-1',
          role: 'owner',
        },
      }),
      pool,
    );
    expect(email).toBe('owner@shop.com');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('COALESCE'), [
      'tenant-1',
      'user_abc',
    ]);
  });

  it('returns null when nothing is available', async () => {
    const email = await resolveOwnerEmail(
      req({
        auth: {
          userId: 'u',
          sessionId: 's',
          tenantId: 't',
          role: 'owner',
        },
      }),
    );
    expect(email).toBeNull();
  });
});

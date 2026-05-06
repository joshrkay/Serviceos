import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryPendingInvitationRepository,
  validateInvitationInput,
} from '../../src/users/pending-invitation';

const TENANT = 'tenant-pending-invite';

describe('PendingInvitationRepository — Tier 4 Team members (PR 3)', () => {
  let repo: InMemoryPendingInvitationRepository;
  beforeEach(() => {
    repo = new InMemoryPendingInvitationRepository();
  });

  it('create persists a pending invitation with email lowercased', async () => {
    const inv = await repo.create({
      tenantId: TENANT,
      email: 'Jane@Example.COM',
      role: 'technician',
      invitedBy: 'user-owner',
    });
    expect(inv.email).toBe('jane@example.com');
    expect(inv.acceptedAt).toBeNull();
    expect(inv.createdAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(inv.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('rejects a duplicate pending invitation for the same (tenant, email)', async () => {
    await repo.create({
      tenantId: TENANT, email: 'jane@example.com',
      role: 'technician', invitedBy: 'user-owner',
    });
    await expect(
      repo.create({
        tenantId: TENANT, email: 'jane@example.com',
        role: 'dispatcher', invitedBy: 'user-owner',
      }),
    ).rejects.toThrow(/already exists/i);
  });

  it('findByTenant returns only pending invitations by default', async () => {
    const a = await repo.create({
      tenantId: TENANT, email: 'a@example.com',
      role: 'technician', invitedBy: 'user-owner',
    });
    await repo.create({
      tenantId: TENANT, email: 'b@example.com',
      role: 'dispatcher', invitedBy: 'user-owner',
    });
    await repo.markAccepted(a.id);

    const list = await repo.findByTenant(TENANT);
    expect(list.map((r) => r.email)).toEqual(['b@example.com']);
  });

  it('findByTenant includes accepted ones when asked', async () => {
    const a = await repo.create({
      tenantId: TENANT, email: 'a@example.com',
      role: 'technician', invitedBy: 'user-owner',
    });
    await repo.markAccepted(a.id);
    const list = await repo.findByTenant(TENANT, { includeAccepted: true });
    expect(list).toHaveLength(1);
  });

  it('findPendingByEmail crosses tenant boundary (webhook lookup)', async () => {
    await repo.create({
      tenantId: TENANT, email: 'jane@example.com',
      role: 'technician', invitedBy: 'user-owner',
    });
    const found = await repo.findPendingByEmail('jane@example.com');
    expect(found?.tenantId).toBe(TENANT);
    // Case-insensitive match.
    const foundCase = await repo.findPendingByEmail('JANE@example.com');
    expect(foundCase?.id).toBe(found!.id);
  });

  it('findPendingByEmail ignores accepted invitations', async () => {
    const inv = await repo.create({
      tenantId: TENANT, email: 'jane@example.com',
      role: 'technician', invitedBy: 'user-owner',
    });
    await repo.markAccepted(inv.id);
    const found = await repo.findPendingByEmail('jane@example.com');
    expect(found).toBeNull();
  });

  it('validateInvitationInput catches malformed inputs', () => {
    expect(validateInvitationInput({
      tenantId: '', email: 'bad', role: 'technician', invitedBy: 'u',
    })).toEqual(expect.arrayContaining([
      'tenantId is required',
      'valid email is required',
    ]));
    expect(validateInvitationInput({
      tenantId: TENANT, email: 'ok@example.com', role: 'admin' as never, invitedBy: 'u',
    })).toContain('role is invalid');
  });
});

/**
 * P10-001 — portal-service unit tests.
 */
import { describe, it, expect } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import {
  createPortalSession,
  generatePortalTokenPair,
  hashPortalToken,
  resolvePortalToken,
  revokePortalSession,
  tokenHashesEqual,
} from '../../src/portal/portal-service';
import { InMemoryPortalSessionRepository } from '../../src/portal/portal-session';

const TENANT = uuidv4();
const CUSTOMER = uuidv4();
const ACTOR = 'user-test';

describe('P10-001 portal-service: token generation', () => {
  it('generatePortalTokenPair returns 64 hex token and matching sha256 hash', () => {
    const { token, tokenHash } = generatePortalTokenPair();
    expect(token).toHaveLength(64);
    expect(/^[0-9a-f]+$/i.test(token)).toBe(true);
    expect(tokenHash).toBe(hashPortalToken(token));
    expect(tokenHash).toHaveLength(64);
  });

  it('tokenHashesEqual returns true for identical hashes', () => {
    const { tokenHash } = generatePortalTokenPair();
    expect(tokenHashesEqual(tokenHash, tokenHash)).toBe(true);
  });

  it('tokenHashesEqual returns false for different hashes', () => {
    const a = generatePortalTokenPair().tokenHash;
    const b = generatePortalTokenPair().tokenHash;
    expect(tokenHashesEqual(a, b)).toBe(false);
  });

  it('tokenHashesEqual returns false for length mismatch', () => {
    expect(tokenHashesEqual('abc', 'abcdef')).toBe(false);
  });
});

describe('P10-001 portal-service: createPortalSession', () => {
  it('returns plaintext token + expiresAt; persists only the hash', async () => {
    const repo = new InMemoryPortalSessionRepository();
    const before = Date.now();
    const result = await createPortalSession(TENANT, CUSTOMER, ACTOR, repo, 7);
    expect(result.token).toHaveLength(64);
    expect(result.expiresAt.getTime()).toBeGreaterThan(before);
    expect(result.expiresAt.getTime()).toBeLessThanOrEqual(
      before + 7 * 24 * 60 * 60 * 1000 + 100,
    );

    // The persisted row stores the hash, not the plaintext.
    const stored = await repo.findByTokenHash(hashPortalToken(result.token));
    expect(stored).not.toBeNull();
    expect(stored!.tenantId).toBe(TENANT);
    expect(stored!.customerId).toBe(CUSTOMER);
    expect(stored!.tokenHash).not.toBe(result.token);
  });

  it('rejects missing tenantId / customerId / createdBy', async () => {
    const repo = new InMemoryPortalSessionRepository();
    await expect(createPortalSession('', CUSTOMER, ACTOR, repo)).rejects.toThrow();
    await expect(createPortalSession(TENANT, '', ACTOR, repo)).rejects.toThrow();
    await expect(createPortalSession(TENANT, CUSTOMER, '', repo)).rejects.toThrow();
  });

  it('rejects non-positive ttlDays', async () => {
    const repo = new InMemoryPortalSessionRepository();
    await expect(createPortalSession(TENANT, CUSTOMER, ACTOR, repo, 0)).rejects.toThrow();
    await expect(createPortalSession(TENANT, CUSTOMER, ACTOR, repo, -1)).rejects.toThrow();
  });
});

describe('P10-001 portal-service: resolvePortalToken', () => {
  it('returns the resolved tenant + customer for a valid token', async () => {
    const repo = new InMemoryPortalSessionRepository();
    const { token } = await createPortalSession(TENANT, CUSTOMER, ACTOR, repo);
    const resolved = await resolvePortalToken(token, repo);
    expect(resolved).not.toBeNull();
    expect(resolved!.tenantId).toBe(TENANT);
    expect(resolved!.customerId).toBe(CUSTOMER);
    expect(resolved!.sessionId).toBeTruthy();
  });

  it('returns null for an unknown token', async () => {
    const repo = new InMemoryPortalSessionRepository();
    // 64 hex chars but not stored.
    const fake = 'a'.repeat(64);
    const resolved = await resolvePortalToken(fake, repo);
    expect(resolved).toBeNull();
  });

  it('returns null for malformed token (wrong length / non-hex)', async () => {
    const repo = new InMemoryPortalSessionRepository();
    await createPortalSession(TENANT, CUSTOMER, ACTOR, repo);
    expect(await resolvePortalToken('', repo)).toBeNull();
    expect(await resolvePortalToken('not-hex-token', repo)).toBeNull();
    expect(await resolvePortalToken('a'.repeat(63), repo)).toBeNull();
    expect(await resolvePortalToken('z'.repeat(64), repo)).toBeNull();
  });

  it('returns null for an expired token', async () => {
    const repo = new InMemoryPortalSessionRepository();
    const { token, expiresAt } = await createPortalSession(TENANT, CUSTOMER, ACTOR, repo, 1);
    const after = new Date(expiresAt.getTime() + 1000);
    expect(await resolvePortalToken(token, repo, after)).toBeNull();
  });

  it('returns null for a revoked token', async () => {
    const repo = new InMemoryPortalSessionRepository();
    const { token, id } = await createPortalSession(TENANT, CUSTOMER, ACTOR, repo);
    await revokePortalSession(TENANT, id, repo);
    expect(await resolvePortalToken(token, repo)).toBeNull();
  });

  it('updates last_accessed_at on successful resolve', async () => {
    const repo = new InMemoryPortalSessionRepository();
    const { token, id } = await createPortalSession(TENANT, CUSTOMER, ACTOR, repo);
    const before = await repo.findById(TENANT, id);
    expect(before!.lastAccessedAt).toBeUndefined();
    await resolvePortalToken(token, repo);
    const after = await repo.findById(TENANT, id);
    expect(after!.lastAccessedAt).toBeInstanceOf(Date);
  });
});

describe('P10-001 portal-service: revokePortalSession', () => {
  it('marks the session revoked', async () => {
    const repo = new InMemoryPortalSessionRepository();
    const { id } = await createPortalSession(TENANT, CUSTOMER, ACTOR, repo);
    const revoked = await revokePortalSession(TENANT, id, repo);
    expect(revoked).not.toBeNull();
    expect(revoked!.revokedAt).toBeInstanceOf(Date);
  });

  it('returns null when the session does not exist for this tenant', async () => {
    const repo = new InMemoryPortalSessionRepository();
    const { id } = await createPortalSession(TENANT, CUSTOMER, ACTOR, repo);
    const otherTenant = uuidv4();
    const revoked = await revokePortalSession(otherTenant, id, repo);
    expect(revoked).toBeNull();
  });
});

// ─── Comms C2 / I14 — contact-bound sessions + read-time entitlement ─────────

import { InMemoryContactRepository } from '../../src/customers/contact';
import type { CustomerContact, CustomerContactRole } from '../../src/customers/contact';
import {
  entitlementAllows,
  entitlementForRole,
} from '../../src/portal/portal-entitlement';

function makeContact(overrides: Partial<CustomerContact> = {}): CustomerContact {
  return {
    id: uuidv4(),
    tenantId: TENANT,
    customerId: CUSTOMER,
    name: 'Terry Tenant',
    role: 'site',
    isPrimary: false,
    isArchived: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('C2 portal-entitlement: role mapping', () => {
  it.each([
    ['primary', 'billing'],
    ['billing', 'billing'],
    ['site', 'service'],
    ['other', 'service'],
  ] as Array<[CustomerContactRole, string]>)(
    'role %s → %s surface',
    (role, expected) => {
      expect(entitlementForRole(role)).toBe(expected);
    },
  );

  it('unknown future roles fail safe to the service surface', () => {
    expect(entitlementForRole('landlord_liaison' as CustomerContactRole)).toBe('service');
  });

  it('billing subsumes service; service never reads billing', () => {
    expect(entitlementAllows('billing', 'billing')).toBe(true);
    expect(entitlementAllows('billing', 'service')).toBe(true);
    expect(entitlementAllows('service', 'service')).toBe(true);
    expect(entitlementAllows('service', 'billing')).toBe(false);
  });
});

describe('C2 resolvePortalToken: contact-bound sessions', () => {
  async function mintBound(
    contactRepo: InMemoryContactRepository,
    contact: CustomerContact,
  ) {
    await contactRepo.create(contact);
    const repo = new InMemoryPortalSessionRepository();
    const created = await createPortalSession(
      TENANT, CUSTOMER, ACTOR, repo, 7, undefined, undefined,
      { contactId: contact.id },
    );
    return { repo, created };
  }

  it('account-holder session (no contact) keeps the billing surface', async () => {
    const repo = new InMemoryPortalSessionRepository();
    const created = await createPortalSession(TENANT, CUSTOMER, ACTOR, repo, 7);
    const resolved = await resolvePortalToken(created.token, repo);
    expect(resolved!.entitlement).toBe('billing');
    expect(resolved!.contactId).toBeUndefined();
  });

  it('site-role contact resolves to the service surface', async () => {
    const contacts = new InMemoryContactRepository();
    const contact = makeContact({ role: 'site' });
    const { repo, created } = await mintBound(contacts, contact);
    const resolved = await resolvePortalToken(created.token, repo, new Date(), contacts);
    expect(resolved).not.toBeNull();
    expect(resolved!.contactId).toBe(contact.id);
    expect(resolved!.entitlement).toBe('service');
  });

  it('billing-role contact resolves to the billing surface', async () => {
    const contacts = new InMemoryContactRepository();
    const contact = makeContact({ role: 'billing' });
    const { repo, created } = await mintBound(contacts, contact);
    const resolved = await resolvePortalToken(created.token, repo, new Date(), contacts);
    expect(resolved!.entitlement).toBe('billing');
  });

  it('entitlement follows the contact CURRENT role, not mint-time state', async () => {
    const contacts = new InMemoryContactRepository();
    const contact = makeContact({ role: 'billing' });
    const { repo, created } = await mintBound(contacts, contact);
    // Role demoted after the token was minted — the next read must see it.
    await contacts.update(TENANT, contact.id, { role: 'site' });
    const resolved = await resolvePortalToken(created.token, repo, new Date(), contacts);
    expect(resolved!.entitlement).toBe('service');
  });

  it('fails closed (null) when the bound contact is archived', async () => {
    const contacts = new InMemoryContactRepository();
    const contact = makeContact({ role: 'site' });
    const { repo, created } = await mintBound(contacts, contact);
    await contacts.update(TENANT, contact.id, { isArchived: true, archivedAt: new Date() });
    expect(await resolvePortalToken(created.token, repo, new Date(), contacts)).toBeNull();
  });

  it('fails closed (null) when the bound contact no longer exists', async () => {
    const contacts = new InMemoryContactRepository();
    const contact = makeContact();
    const { repo, created } = await mintBound(new InMemoryContactRepository(), contact);
    // Resolve against an EMPTY contact repo — the contact is gone.
    expect(await resolvePortalToken(created.token, repo, new Date(), contacts)).toBeNull();
  });

  it('fails closed (null) when the contact belongs to a different customer', async () => {
    const contacts = new InMemoryContactRepository();
    const contact = makeContact({ customerId: uuidv4() });
    await contacts.create(contact);
    const repo = new InMemoryPortalSessionRepository();
    const created = await createPortalSession(
      TENANT, CUSTOMER, ACTOR, repo, 7, undefined, undefined,
      { contactId: contact.id },
    );
    expect(await resolvePortalToken(created.token, repo, new Date(), contacts)).toBeNull();
  });

  it('fails closed (null) when no contactRepo is wired for a contact-bound session', async () => {
    const contacts = new InMemoryContactRepository();
    const contact = makeContact();
    const { repo, created } = await mintBound(contacts, contact);
    expect(await resolvePortalToken(created.token, repo, new Date())).toBeNull();
  });
});

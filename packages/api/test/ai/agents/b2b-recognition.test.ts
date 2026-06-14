/**
 * U4 — B2B inbound recognition + priority routing.
 *
 * Handler-level coverage with the in-memory customer repo (mocked DB):
 *  - a known property-manager number → assembled context carries the parent
 *    (when a sub-account), the sub-accounts, and the priority + occupied seam;
 *  - an unknown number CLAIMING a PM account → a confidence marker, NO
 *    association (the assessment never carries a customerId);
 *  - a missing parent → graceful standalone (still priority).
 */
import { describe, it, expect } from 'vitest';
import {
  assembleB2bAccountContext,
  assessUnverifiedB2bClaim,
  isBusinessAccount,
  buildAccountContextPromptSection,
  UNVERIFIED_B2B_CLAIM_MARKER_REASON,
} from '../../../src/ai/agents/customer-calling/b2b-account-context';
import {
  InMemoryCustomerRepository,
  type Customer,
} from '../../../src/customers/customer';

const TENANT = 'tenant-u4';
const OTHER_TENANT = 'tenant-other';

function makeCustomer(overrides: Partial<Customer> = {}): Customer {
  const now = new Date('2026-06-14T00:00:00Z');
  return {
    id: crypto.randomUUID(),
    tenantId: TENANT,
    firstName: 'Pat',
    lastName: 'Property',
    displayName: 'Pat Property',
    preferredChannel: 'phone',
    smsConsent: false,
    isArchived: false,
    createdBy: 'user-1',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function seed(
  repo: InMemoryCustomerRepository,
  c: Customer,
): Promise<Customer> {
  return repo.create(c);
}

describe('U4 — isBusinessAccount', () => {
  it('is true for b2b and property_manager, false otherwise', () => {
    expect(isBusinessAccount('b2b')).toBe(true);
    expect(isBusinessAccount('property_manager')).toBe(true);
    expect(isBusinessAccount('residential')).toBe(false);
    expect(isBusinessAccount(undefined)).toBe(false);
  });
});

describe('U4 — assembleB2bAccountContext (known PM number)', () => {
  it('routes a property-manager parent with its sub-accounts + priority', async () => {
    const repo = new InMemoryCustomerRepository();
    const parent = await seed(
      repo,
      makeCustomer({
        displayName: 'Acme Property Mgmt',
        accountType: 'property_manager',
      }),
    );
    const unitA = await seed(
      repo,
      makeCustomer({
        displayName: 'Acme — Unit A',
        accountType: 'b2b',
        parentAccountId: parent.id,
      }),
    );
    const unitB = await seed(
      repo,
      makeCustomer({
        displayName: 'Acme — Unit B',
        accountType: 'b2b',
        parentAccountId: parent.id,
      }),
    );

    const ctx = await assembleB2bAccountContext({
      tenantId: TENANT,
      customer: parent,
      repo,
    });

    expect(ctx).not.toBeNull();
    expect(ctx!.priority).toBe(true);
    expect(ctx!.accountType).toBe('property_manager');
    expect(ctx!.parentAccount).toBeUndefined(); // parent has no parent
    expect(ctx!.parentMissing).toBe(false);
    const subIds = ctx!.subAccounts.map((s) => s.customerId).sort();
    expect(subIds).toEqual([unitA.id, unitB.id].sort());
  });

  it('loads the parent + sibling portfolio when the caller is a sub-account', async () => {
    const repo = new InMemoryCustomerRepository();
    const parent = await seed(
      repo,
      makeCustomer({
        displayName: 'Acme Property Mgmt',
        accountType: 'property_manager',
      }),
    );
    const unitA = await seed(
      repo,
      makeCustomer({
        displayName: 'Acme — Unit A',
        accountType: 'b2b',
        parentAccountId: parent.id,
      }),
    );
    const unitB = await seed(
      repo,
      makeCustomer({
        displayName: 'Acme — Unit B',
        accountType: 'b2b',
        parentAccountId: parent.id,
      }),
    );

    // The caller is unitA (a managed property that itself called in).
    const ctx = await assembleB2bAccountContext({
      tenantId: TENANT,
      customer: unitA,
      repo,
    });

    expect(ctx).not.toBeNull();
    expect(ctx!.priority).toBe(true);
    expect(ctx!.parentAccount?.customerId).toBe(parent.id);
    expect(ctx!.parentAccount?.displayName).toBe('Acme Property Mgmt');
    expect(ctx!.parentMissing).toBe(false);
    // Siblings are loaded off the parent, and the caller is never listed as
    // its own sub-account.
    const subIds = ctx!.subAccounts.map((s) => s.customerId);
    expect(subIds).toContain(unitB.id);
    expect(subIds).not.toContain(unitA.id);
  });

  it('threads a known occupied-property signal into the context', async () => {
    const repo = new InMemoryCustomerRepository();
    const pm = await seed(
      repo,
      makeCustomer({ accountType: 'property_manager' }),
    );
    const ctx = await assembleB2bAccountContext({
      tenantId: TENANT,
      customer: pm,
      repo,
      currentlyOccupied: true,
    });
    expect(ctx!.currentlyOccupied).toBe(true);
  });

  it('returns null for a residential caller (routes unchanged)', async () => {
    const repo = new InMemoryCustomerRepository();
    const res = await seed(repo, makeCustomer({ accountType: 'residential' }));
    const ctx = await assembleB2bAccountContext({
      tenantId: TENANT,
      customer: res,
      repo,
    });
    expect(ctx).toBeNull();
  });

  it('does not leak sub-accounts across tenants (tenant-scoped lookup)', async () => {
    const repo = new InMemoryCustomerRepository();
    const parent = await seed(
      repo,
      makeCustomer({ accountType: 'property_manager' }),
    );
    // A sub-account that belongs to ANOTHER tenant but points at the same
    // parent id must never appear in this tenant's portfolio.
    await seed(
      repo,
      makeCustomer({
        tenantId: OTHER_TENANT,
        displayName: 'Cross-tenant unit',
        accountType: 'b2b',
        parentAccountId: parent.id,
      }),
    );
    const ctx = await assembleB2bAccountContext({
      tenantId: TENANT,
      customer: parent,
      repo,
    });
    expect(ctx!.subAccounts).toHaveLength(0);
  });
});

describe('U4 — assembleB2bAccountContext (graceful degradation)', () => {
  it('treats a missing parent as standalone but still priority', async () => {
    const repo = new InMemoryCustomerRepository();
    // A sub-account whose parent row does not exist (e.g. deleted). The
    // in-memory repo does not enforce the FK, so this models the runtime
    // "parent gone" case the Pg cycle-guard would otherwise have caught.
    const orphan = await seed(
      repo,
      makeCustomer({
        displayName: 'Orphaned managed unit',
        accountType: 'b2b',
        parentAccountId: crypto.randomUUID(),
      }),
    );
    const ctx = await assembleB2bAccountContext({
      tenantId: TENANT,
      customer: orphan,
      repo,
    });
    expect(ctx).not.toBeNull();
    expect(ctx!.priority).toBe(true);
    expect(ctx!.parentMissing).toBe(true);
    expect(ctx!.parentAccount).toBeUndefined();
  });

  it('degrades to no sub-accounts when the repo lacks findByParentAccount', async () => {
    // A minimal repo fake (older test-style) WITHOUT the optional
    // findByParentAccount method — the recognition path must not throw.
    const pm = makeCustomer({ accountType: 'property_manager' });
    const minimalRepo = {
      findById: async () => null,
    } as unknown as InMemoryCustomerRepository;
    const ctx = await assembleB2bAccountContext({
      tenantId: TENANT,
      customer: pm,
      repo: minimalRepo,
    });
    expect(ctx).not.toBeNull();
    expect(ctx!.subAccounts).toHaveLength(0);
    expect(ctx!.parentMissing).toBe(false);
  });

  it('survives a repo that throws on lookup (best-effort)', async () => {
    const pm = makeCustomer({
      accountType: 'b2b',
      parentAccountId: crypto.randomUUID(),
    });
    const throwingRepo = {
      findById: async () => {
        throw new Error('db down');
      },
      findByParentAccount: async () => {
        throw new Error('db down');
      },
    } as unknown as InMemoryCustomerRepository;
    const ctx = await assembleB2bAccountContext({
      tenantId: TENANT,
      customer: pm,
      repo: throwingRepo,
    });
    expect(ctx).not.toBeNull();
    expect(ctx!.priority).toBe(true);
    expect(ctx!.parentMissing).toBe(true);
    expect(ctx!.subAccounts).toHaveLength(0);
  });
});

describe('U4 — assessUnverifiedB2bClaim (unknown number claiming a PM account)', () => {
  it('emits a low-confidence marker and does NOT associate', () => {
    const assessment = assessUnverifiedB2bClaim({
      claimedAccountName: 'Acme Property Mgmt',
      callerPhone: '+15125550199',
    });

    // No association: the assessment never carries a customerId.
    expect(assessment.associated).toBe(false);
    expect(assessment).not.toHaveProperty('customerId');
    expect(assessment.claimedAccountName).toBe('Acme Property Mgmt');

    // It is a confidence marker reusing the shared guardrail.
    expect(assessment.markerReason).toBe(UNVERIFIED_B2B_CLAIM_MARKER_REASON);
    expect(assessment.level).toBe('very_low');
    expect(assessment.confidence.score).toBeLessThan(0.3);
    // The guardrail records WHY (factors) so review surfaces can render it.
    expect(assessment.confidence.factors).toContain('model_provided_confidence');
    expect(assessment.confidence.factors).toContain('explanation_present');
  });

  it('records the claim without a caller phone when none is available', () => {
    const assessment = assessUnverifiedB2bClaim({
      claimedAccountName: 'Globex Facilities',
    });
    expect(assessment.associated).toBe(false);
    expect(assessment.claimedAccountName).toBe('Globex Facilities');
  });
});

describe('U4 — buildAccountContextPromptSection', () => {
  it('marks the call priority and lists managed properties', async () => {
    const repo = new InMemoryCustomerRepository();
    const parent = await seed(
      repo,
      makeCustomer({
        displayName: 'Acme Property Mgmt',
        accountType: 'property_manager',
      }),
    );
    await seed(
      repo,
      makeCustomer({
        displayName: 'Acme — Unit A',
        accountType: 'b2b',
        parentAccountId: parent.id,
      }),
    );
    const ctx = await assembleB2bAccountContext({
      tenantId: TENANT,
      customer: parent,
      repo,
    });
    const section = buildAccountContextPromptSection(ctx!);
    expect(section).toMatch(/PRIORITY/);
    expect(section).toMatch(/property-management/);
    expect(section).toMatch(/Acme — Unit A/);
    expect(section).toMatch(/occupied/i);
  });

  it('names the parent for a sub-account caller', async () => {
    const repo = new InMemoryCustomerRepository();
    const parent = await seed(
      repo,
      makeCustomer({
        displayName: 'Acme Property Mgmt',
        accountType: 'property_manager',
      }),
    );
    const unit = await seed(
      repo,
      makeCustomer({
        displayName: 'Acme — Unit A',
        accountType: 'b2b',
        parentAccountId: parent.id,
      }),
    );
    const ctx = await assembleB2bAccountContext({
      tenantId: TENANT,
      customer: unit,
      repo,
    });
    const section = buildAccountContextPromptSection(ctx!);
    expect(section).toMatch(/managed property under the account "Acme Property Mgmt"/);
  });
});

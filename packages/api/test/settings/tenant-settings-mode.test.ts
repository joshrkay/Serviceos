import { describe, it, expect, beforeEach } from 'vitest';
import {
  createSettings,
  updateSettings,
  InMemorySettingsRepository,
  UNSUPERVISED_PROPOSAL_ROUTING_VALUES,
  type TenantSettings,
} from '../../src/settings/settings';
import { updateSettingsSchema } from '../../src/shared/contracts';

describe('P12-005 — backupSupervisorUserId + unsupervisedProposalRouting persistence', () => {
  let repo: InMemorySettingsRepository;
  let initial: TenantSettings;
  const TENANT = 'tenant-1';
  const USER_A = '11111111-1111-1111-1111-111111111111';
  const USER_B = '22222222-2222-2222-2222-222222222222';

  beforeEach(async () => {
    repo = new InMemorySettingsRepository();
    initial = await createSettings(
      { tenantId: TENANT, businessName: 'ACME HVAC' },
      repo,
    );
  });

  it('exposes the locked enum values in source order', () => {
    expect(UNSUPERVISED_PROPOSAL_ROUTING_VALUES).toEqual([
      'queue_and_sms',
      'queue_only',
      'escalate_to_oncall',
    ]);
  });

  it('round-trips backupSupervisorUserId through updateSettings', async () => {
    const updated = await updateSettings(
      TENANT,
      { backupSupervisorUserId: USER_A },
      repo,
    );
    expect(updated?.backupSupervisorUserId).toBe(USER_A);

    // Re-update to a different user.
    const reassigned = await updateSettings(
      TENANT,
      { backupSupervisorUserId: USER_B },
      repo,
    );
    expect(reassigned?.backupSupervisorUserId).toBe(USER_B);

    // Explicit null clears the backup.
    const cleared = await updateSettings(
      TENANT,
      { backupSupervisorUserId: null },
      repo,
    );
    expect(cleared?.backupSupervisorUserId).toBeNull();
  });

  it('round-trips unsupervisedProposalRouting through updateSettings', async () => {
    for (const value of UNSUPERVISED_PROPOSAL_ROUTING_VALUES) {
      const updated = await updateSettings(
        TENANT,
        { unsupervisedProposalRouting: value },
        repo,
      );
      expect(updated?.unsupervisedProposalRouting).toBe(value);
    }
  });

  it('updates both fields together without affecting unrelated fields', async () => {
    const updated = await updateSettings(
      TENANT,
      {
        backupSupervisorUserId: USER_A,
        unsupervisedProposalRouting: 'queue_only',
      },
      repo,
    );

    expect(updated?.backupSupervisorUserId).toBe(USER_A);
    expect(updated?.unsupervisedProposalRouting).toBe('queue_only');
    // Unchanged fields stay put.
    expect(updated?.businessName).toBe(initial.businessName);
    expect(updated?.timezone).toBe(initial.timezone);
    expect(updated?.estimatePrefix).toBe(initial.estimatePrefix);
  });
});

describe('P12-005 — updateSettingsSchema (Zod) accepts the new fields and validates the enum', () => {
  it('accepts a valid backupSupervisorUserId UUID', () => {
    const parsed = updateSettingsSchema.safeParse({
      backupSupervisorUserId: '11111111-1111-1111-1111-111111111111',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts null to clear the backup supervisor', () => {
    const parsed = updateSettingsSchema.safeParse({
      backupSupervisorUserId: null,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a non-UUID backupSupervisorUserId', () => {
    const parsed = updateSettingsSchema.safeParse({
      backupSupervisorUserId: 'not-a-uuid',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts each of the three locked routing enum values', () => {
    for (const v of ['queue_and_sms', 'queue_only', 'escalate_to_oncall']) {
      const parsed = updateSettingsSchema.safeParse({
        unsupervisedProposalRouting: v,
      });
      expect(parsed.success).toBe(true);
    }
  });

  it('rejects an unknown routing value', () => {
    const parsed = updateSettingsSchema.safeParse({
      unsupervisedProposalRouting: 'something_else',
    });
    expect(parsed.success).toBe(false);
  });

  it('keeps both fields optional (empty body parses)', () => {
    const parsed = updateSettingsSchema.safeParse({});
    expect(parsed.success).toBe(true);
  });
});

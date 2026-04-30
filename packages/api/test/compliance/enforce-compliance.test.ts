import { describe, it, expect, beforeEach } from 'vitest';
import {
  enforceCompliance,
  ComplianceCheckInput,
} from '../../src/ai/skills/enforce-compliance';
import { InMemoryDncRepository } from '../../src/compliance/dnc';
import { InMemorySettingsRepository } from '../../src/settings/settings';

// ── Helpers ────────────────────────────────────────────────────────────────

const TENANT_ID = 'tenant-abc';
const TUESDAY_10AM_UTC = new Date('2026-04-28T15:00:00Z'); // Tue 10:00 America/Chicago
const TUESDAY_10AM_CHICAGO = new Date('2026-04-28T15:00:00Z'); // same UTC reference

async function makeSettingsRepo(timezone = 'America/Chicago', withSchedule = false) {
  const repo = new InMemorySettingsRepository();
  const settings = {
    id: 'settings-1',
    tenantId: TENANT_ID,
    businessName: 'Test HVAC',
    timezone,
    estimatePrefix: 'EST-',
    invoicePrefix: 'INV-',
    nextEstimateNumber: 1,
    nextInvoiceNumber: 1,
    defaultPaymentTermDays: 30,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...(withSchedule
      ? {
          businessHoursSchedule: [
            { dayOfWeek: 2, openTime: '08:00', closeTime: '17:00' }, // Tuesday
          ],
        }
      : {}),
  };
  await repo.create(settings as Parameters<typeof repo.create>[0]);
  return repo;
}

function makeInput(
  overrides: Partial<ComplianceCheckInput> = {}
): ComplianceCheckInput {
  return {
    tenantId: TENANT_ID,
    callerPhone: '+15551234567',
    channel: 'telephony',
    currentTime: TUESDAY_10AM_UTC,
    settingsRepo: new InMemorySettingsRepository(),
    dncRepo: new InMemoryDncRepository(),
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('enforceCompliance', () => {
  describe('DNC hit → blocked', () => {
    it('blocks the caller when their phone is on the DNC list', async () => {
      const dncRepo = new InMemoryDncRepository();
      dncRepo.add(TENANT_ID, '15551234567'); // normalised from +15551234567

      const result = await enforceCompliance(
        makeInput({ dncRepo, settingsRepo: await makeSettingsRepo() })
      );

      expect(result.allowed).toBe(false);
      expect(result.reasons).toContain('dnc_blocked');
      expect(result.isAfterHours).toBe(false);
    });
  });

  describe('DNC miss + within business hours → allowed', () => {
    it('allows the caller when they are not on DNC and within hours', async () => {
      // Tuesday 10:00 AM Chicago, schedule has Tue 08:00–17:00
      const settingsRepo = await makeSettingsRepo('America/Chicago', true);
      const dncRepo = new InMemoryDncRepository();

      const result = await enforceCompliance(
        makeInput({ settingsRepo, dncRepo, currentTime: TUESDAY_10AM_CHICAGO })
      );

      expect(result.allowed).toBe(true);
      expect(result.reasons).toContain('open');
      expect(result.isAfterHours).toBe(false);
    });
  });

  describe('after hours → allowed with after_hours reason', () => {
    it('allows the caller but flags after_hours when outside schedule', async () => {
      const settingsRepo = await makeSettingsRepo('America/Chicago', true);
      // Tuesday 22:00 UTC = 17:00 Chicago — at the boundary (exclusive), so after hours
      const afterHoursTime = new Date('2026-04-28T22:00:00Z');

      const result = await enforceCompliance(
        makeInput({ settingsRepo, currentTime: afterHoursTime })
      );

      expect(result.allowed).toBe(true);
      expect(result.reasons).toContain('after_hours');
      expect(result.isAfterHours).toBe(true);
    });

    it('flags after_hours when the current day has no schedule entry', async () => {
      // Sunday — schedule only has Tuesday
      const settingsRepo = await makeSettingsRepo('America/Chicago', true);
      const sunday10AM = new Date('2026-04-26T15:00:00Z'); // Sun 10:00 Chicago

      const result = await enforceCompliance(
        makeInput({ settingsRepo, currentTime: sunday10AM })
      );

      expect(result.allowed).toBe(true);
      expect(result.reasons).toContain('after_hours');
      expect(result.isAfterHours).toBe(true);
    });
  });

  describe('in-app channel → always allowed', () => {
    it('allows in-app calls regardless of business hours', async () => {
      // After-hours time, but in-app channel
      const settingsRepo = await makeSettingsRepo('America/Chicago', true);
      const afterHoursTime = new Date('2026-04-28T22:00:00Z');

      const result = await enforceCompliance(
        makeInput({ settingsRepo, channel: 'inapp', currentTime: afterHoursTime })
      );

      expect(result.allowed).toBe(true);
      expect(result.isAfterHours).toBe(false);
    });

    it('allows in-app calls even when caller is on DNC list', async () => {
      const dncRepo = new InMemoryDncRepository();
      dncRepo.add(TENANT_ID, '15551234567');
      const settingsRepo = await makeSettingsRepo();

      const result = await enforceCompliance(
        makeInput({ dncRepo, settingsRepo, channel: 'inapp' })
      );

      expect(result.allowed).toBe(true);
    });
  });

  describe('missing settings → default to open', () => {
    it('treats calls as allowed when settings cannot be found', async () => {
      // Empty repo — no settings for this tenant
      const settingsRepo = new InMemorySettingsRepository();

      const result = await enforceCompliance(makeInput({ settingsRepo }));

      expect(result.allowed).toBe(true);
      // Reason is 'open' because no_schedule_configured falls through
      expect(result.isAfterHours).toBe(false);
    });
  });

  describe('DNC service error → fail open', () => {
    it('allows caller when DNC repo throws', async () => {
      const faultyDncRepo = {
        async isOnDnc(): Promise<boolean> {
          throw new Error('Database unavailable');
        },
      };
      const settingsRepo = await makeSettingsRepo('America/Chicago', true);

      const result = await enforceCompliance(
        makeInput({ dncRepo: faultyDncRepo, settingsRepo })
      );

      expect(result.allowed).toBe(true);
      expect(result.reasons).not.toContain('dnc_blocked');
    });
  });
});

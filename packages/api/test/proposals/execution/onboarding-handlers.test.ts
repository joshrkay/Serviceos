import { describe, it, expect, beforeEach } from 'vitest';
import {
  OnboardingTenantSettingsExecutionHandler,
  OnboardingScheduleExecutionHandler,
  OnboardingEstimateTemplateExecutionHandler,
  OnboardingServiceCategoryExecutionHandler,
  OnboardingTeamMemberExecutionHandler,
} from '../../../src/proposals/execution/onboarding-handlers';
import { createProposal } from '../../../src/proposals/proposal';
import {
  InMemorySettingsRepository,
  type TenantSettings,
} from '../../../src/settings/settings';
import {
  InMemoryPackActivationRepository,
  getActivePacks,
} from '../../../src/settings/pack-activation';
import { InMemoryEstimateTemplateRepository } from '../../../src/templates/estimate-template';
import { InMemoryAuditRepository } from '../../../src/audit/audit';

const TENANT = 'tenant-ob-1';
const USER = 'user-ob-1';
const ctx = { tenantId: TENANT, executedBy: USER };

function seedSettings(repo: InMemorySettingsRepository, overrides: Partial<TenantSettings> = {}) {
  return repo.create({
    id: 'settings-1',
    tenantId: TENANT,
    businessName: '',
    timezone: 'America/New_York',
    estimatePrefix: 'EST-',
    invoicePrefix: 'INV-',
    nextEstimateNumber: 1001,
    nextInvoiceNumber: 1001,
    defaultPaymentTermDays: 30,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
}

describe('onboarding execution handlers', () => {
  describe('OnboardingTenantSettingsExecutionHandler', () => {
    let settingsRepo: InMemorySettingsRepository;
    let packRepo: InMemoryPackActivationRepository;
    let auditRepo: InMemoryAuditRepository;
    let handler: OnboardingTenantSettingsExecutionHandler;

    beforeEach(() => {
      settingsRepo = new InMemorySettingsRepository();
      packRepo = new InMemoryPackActivationRepository();
      auditRepo = new InMemoryAuditRepository();
      // No packSeedDeps — seeding is exercised by the integration test; here we
      // prove name + pack activation + audit.
      handler = new OnboardingTenantSettingsExecutionHandler(
        settingsRepo,
        packRepo,
        undefined,
        auditRepo,
      );
    });

    it('writes business name + activates the extracted packs (existing row)', async () => {
      await seedSettings(settingsRepo);
      const proposal = createProposal({
        tenantId: TENANT,
        proposalType: 'onboarding_tenant_settings',
        payload: { businessName: "Bob's HVAC", verticalPacks: ['hvac'] },
        summary: 'Configure tenant',
        createdBy: USER,
      });

      const result = await handler.execute(proposal, ctx);

      expect(result.success).toBe(true);
      const settings = await settingsRepo.findByTenant(TENANT);
      expect(settings?.businessName).toBe("Bob's HVAC");
      expect(settings?.activeVerticalPacks).toContain('hvac');
      const active = await getActivePacks(TENANT, packRepo);
      expect(active.map((a) => a.packId)).toContain('hvac');
      expect(
        auditRepo.getAll().some((e) => e.eventType === 'onboarding.tenant_settings_applied'),
      ).toBe(true);
    });

    it('bootstraps a settings row when none exists yet (spoke before any form)', async () => {
      const proposal = createProposal({
        tenantId: TENANT,
        proposalType: 'onboarding_tenant_settings',
        payload: { businessName: 'Fresh Co', verticalPacks: ['plumbing'] },
        summary: 'Configure tenant',
        createdBy: USER,
      });

      const result = await handler.execute(proposal, ctx);

      expect(result.success).toBe(true);
      const settings = await settingsRepo.findByTenant(TENANT);
      expect(settings?.businessName).toBe('Fresh Co');
      expect(settings?.activeVerticalPacks).toContain('plumbing');
    });

    it('is idempotent — re-approving does not double-activate the pack', async () => {
      await seedSettings(settingsRepo);
      const proposal = createProposal({
        tenantId: TENANT,
        proposalType: 'onboarding_tenant_settings',
        payload: { businessName: "Bob's HVAC", verticalPacks: ['hvac'] },
        summary: 'Configure tenant',
        createdBy: USER,
      });

      await handler.execute(proposal, ctx);
      await handler.execute(proposal, ctx);

      const active = await getActivePacks(TENANT, packRepo);
      expect(active.filter((a) => a.packId === 'hvac')).toHaveLength(1);
    });

    it('fails when neither a name nor a pack is present', async () => {
      const proposal = createProposal({
        tenantId: TENANT,
        proposalType: 'onboarding_tenant_settings',
        payload: { businessName: '', verticalPacks: [] },
        summary: 'Configure tenant',
        createdBy: USER,
      });

      const result = await handler.execute(proposal, ctx);
      expect(result.success).toBe(false);
    });
  });

  describe('OnboardingScheduleExecutionHandler', () => {
    let settingsRepo: InMemorySettingsRepository;
    let handler: OnboardingScheduleExecutionHandler;

    beforeEach(() => {
      settingsRepo = new InMemorySettingsRepository();
      handler = new OnboardingScheduleExecutionHandler(settingsRepo, new InMemoryAuditRepository());
    });

    it('translates spoken working hours into the business_hours day map', async () => {
      await seedSettings(settingsRepo);
      const proposal = createProposal({
        tenantId: TENANT,
        proposalType: 'onboarding_schedule',
        payload: {
          workingHours: [
            { days: ['monday', 'Tuesday', 'wed'], startTime: '08:00', endTime: '17:00' },
            { days: ['saturday'], startTime: '09:00', endTime: '13:00' },
          ],
        },
        summary: 'Configure hours',
        createdBy: USER,
      });

      const result = await handler.execute(proposal, ctx);

      expect(result.success).toBe(true);
      const settings = await settingsRepo.findByTenant(TENANT);
      expect(settings?.businessHours).toEqual({
        mon: { open: '08:00', close: '17:00' },
        tue: { open: '08:00', close: '17:00' },
        wed: { open: '08:00', close: '17:00' },
        sat: { open: '09:00', close: '13:00' },
      });
    });

    it('merges over existing form-set hours instead of clobbering them', async () => {
      // Operator set Sat via the form; voice only mentions weekdays.
      await seedSettings(settingsRepo, {
        businessHours: { sat: { open: '09:00', close: '13:00' } },
      });
      const proposal = createProposal({
        tenantId: TENANT,
        proposalType: 'onboarding_schedule',
        payload: {
          workingHours: [
            { days: ['monday', 'friday'], startTime: '08:00', endTime: '17:00' },
          ],
        },
        summary: 'Configure hours',
        createdBy: USER,
      });

      const result = await handler.execute(proposal, ctx);

      expect(result.success).toBe(true);
      const settings = await settingsRepo.findByTenant(TENANT);
      // Saturday survives; weekdays are added.
      expect(settings?.businessHours).toEqual({
        sat: { open: '09:00', close: '13:00' },
        mon: { open: '08:00', close: '17:00' },
        fri: { open: '08:00', close: '17:00' },
      });
    });

    it('drops entries with malformed (non-HH:MM) times', async () => {
      await seedSettings(settingsRepo);
      const proposal = createProposal({
        tenantId: TENANT,
        proposalType: 'onboarding_schedule',
        payload: {
          workingHours: [
            { days: ['monday'], startTime: '8am', endTime: '5 pm' },
            { days: ['tuesday'], startTime: '08:00', endTime: '17:00' },
          ],
        },
        summary: 'Configure hours',
        createdBy: USER,
      });

      const result = await handler.execute(proposal, ctx);

      expect(result.success).toBe(true);
      const settings = await settingsRepo.findByTenant(TENANT);
      // Monday's "8am"/"5 pm" is rejected; only the valid Tuesday persists.
      expect(settings?.businessHours).toEqual({ tue: { open: '08:00', close: '17:00' } });
    });

    it('fails when every entry has malformed times', async () => {
      await seedSettings(settingsRepo);
      const proposal = createProposal({
        tenantId: TENANT,
        proposalType: 'onboarding_schedule',
        payload: { workingHours: [{ days: ['monday'], startTime: '8am', endTime: '5pm' }] },
        summary: 'Configure hours',
        createdBy: USER,
      });
      const result = await handler.execute(proposal, ctx);
      expect(result.success).toBe(false);
    });

    it('fails when no working hours are present', async () => {
      await seedSettings(settingsRepo);
      const proposal = createProposal({
        tenantId: TENANT,
        proposalType: 'onboarding_schedule',
        payload: { workingHours: [] },
        summary: 'Configure hours',
        createdBy: USER,
      });
      const result = await handler.execute(proposal, ctx);
      expect(result.success).toBe(false);
    });

    it('fails cleanly when the tenant has no settings row yet', async () => {
      const proposal = createProposal({
        tenantId: TENANT,
        proposalType: 'onboarding_schedule',
        payload: { workingHours: [{ days: ['mon'], startTime: '08:00', endTime: '17:00' }] },
        summary: 'Configure hours',
        createdBy: USER,
      });
      const result = await handler.execute(proposal, ctx);
      expect(result.success).toBe(false);
    });
  });

  describe('OnboardingEstimateTemplateExecutionHandler', () => {
    it('creates a bespoke estimate template from the payload', async () => {
      const templateRepo = new InMemoryEstimateTemplateRepository();
      const handler = new OnboardingEstimateTemplateExecutionHandler(
        templateRepo,
        new InMemoryAuditRepository(),
      );
      const proposal = createProposal({
        tenantId: TENANT,
        proposalType: 'onboarding_estimate_template',
        payload: {
          verticalType: 'hvac',
          categoryId: 'repair',
          templateName: 'AC Repair',
          lineItems: [
            {
              description: 'Diagnostic',
              category: 'labor',
              defaultQuantity: 1,
              defaultUnitPriceCents: 8900,
              taxable: false,
              sortOrder: 0,
            },
          ],
        },
        summary: 'Template',
        createdBy: USER,
      });

      const result = await handler.execute(proposal, ctx);

      expect(result.success).toBe(true);
      const templates = await templateRepo.findByTenant(TENANT);
      expect(templates).toHaveLength(1);
      expect(templates[0].name).toBe('AC Repair');
      expect(templates[0].lineItemTemplates[0].defaultUnitPriceCents).toBe(8900);
    });

    it('fails when required fields are missing', async () => {
      const handler = new OnboardingEstimateTemplateExecutionHandler(
        new InMemoryEstimateTemplateRepository(),
      );
      const proposal = createProposal({
        tenantId: TENANT,
        proposalType: 'onboarding_estimate_template',
        payload: { verticalType: 'hvac', categoryId: 'repair', templateName: 'X', lineItems: [] },
        summary: 'Template',
        createdBy: USER,
      });
      const result = await handler.execute(proposal, ctx);
      expect(result.success).toBe(false);
    });
  });

  describe('acknowledgment handlers (category + team member)', () => {
    it('confirms a pack-defined service category with an audit event', async () => {
      const auditRepo = new InMemoryAuditRepository();
      const handler = new OnboardingServiceCategoryExecutionHandler(auditRepo);
      const proposal = createProposal({
        tenantId: TENANT,
        proposalType: 'onboarding_service_category',
        payload: { verticalType: 'hvac', categoryId: 'repair', displayName: 'AC Repair' },
        summary: 'Category',
        createdBy: USER,
      });
      const result = await handler.execute(proposal, ctx);
      expect(result.success).toBe(true);
      expect(
        auditRepo.getAll().some((e) => e.eventType === 'onboarding.service_category_confirmed'),
      ).toBe(true);
    });

    it('records a captured team member with an audit event', async () => {
      const auditRepo = new InMemoryAuditRepository();
      const handler = new OnboardingTeamMemberExecutionHandler(auditRepo);
      const proposal = createProposal({
        tenantId: TENANT,
        proposalType: 'onboarding_team_member',
        payload: { name: 'Marcus', role: 'technician' },
        summary: 'Team member',
        createdBy: USER,
      });
      const result = await handler.execute(proposal, ctx);
      expect(result.success).toBe(true);
      expect(auditRepo.getAll().some((e) => e.eventType === 'onboarding.team_member_noted')).toBe(true);
    });

    it('rejects a team member with no name', async () => {
      const handler = new OnboardingTeamMemberExecutionHandler(new InMemoryAuditRepository());
      const proposal = createProposal({
        tenantId: TENANT,
        proposalType: 'onboarding_team_member',
        payload: { name: '', role: 'technician' },
        summary: 'Team member',
        createdBy: USER,
      });
      const result = await handler.execute(proposal, ctx);
      expect(result.success).toBe(false);
    });
  });
});

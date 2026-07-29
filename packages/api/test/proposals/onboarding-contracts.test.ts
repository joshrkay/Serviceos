import { describe, it, expect } from 'vitest';
import { validateProposalPayload } from '../../src/proposals/contracts';

describe('Onboarding proposal contract validation', () => {
  describe('onboarding_tenant_settings', () => {
    it('accepts valid tenant settings payload', () => {
      const result = validateProposalPayload('onboarding_tenant_settings', {
        businessName: 'Comfort Zone HVAC',
        city: 'Scottsdale',
        state: 'AZ',
        verticalPacks: ['hvac'],
      });
      expect(result.valid).toBe(true);
    });

    it('accepts dual-vertical payload', () => {
      const result = validateProposalPayload('onboarding_tenant_settings', {
        businessName: 'Desert Home Services',
        verticalPacks: ['hvac', 'plumbing'],
      });
      expect(result.valid).toBe(true);
    });

    it('rejects empty business name', () => {
      const result = validateProposalPayload('onboarding_tenant_settings', {
        businessName: '',
        verticalPacks: ['hvac'],
      });
      expect(result.valid).toBe(false);
    });

    it('rejects empty verticalPacks', () => {
      const result = validateProposalPayload('onboarding_tenant_settings', {
        businessName: 'Test',
        verticalPacks: [],
      });
      expect(result.valid).toBe(false);
    });

    it('accepts electrical as a basic supported vertical type', () => {
      const result = validateProposalPayload('onboarding_tenant_settings', {
        businessName: 'Test',
        verticalPacks: ['electrical'],
      });
      expect(result.valid).toBe(true);
    });
  });

  describe('onboarding_service_category', () => {
    it('accepts valid service category payload', () => {
      const result = validateProposalPayload('onboarding_service_category', {
        verticalType: 'hvac',
        categoryId: 'repair',
        displayName: 'AC Repair',
      });
      expect(result.valid).toBe(true);
    });

    it('rejects missing categoryId', () => {
      const result = validateProposalPayload('onboarding_service_category', {
        verticalType: 'hvac',
        displayName: 'AC Repair',
      });
      expect(result.valid).toBe(false);
    });
  });

  describe('onboarding_estimate_template', () => {
    it('accepts valid template payload', () => {
      const result = validateProposalPayload('onboarding_estimate_template', {
        verticalType: 'hvac',
        categoryId: 'diagnostic',
        templateName: 'Diagnostic',
        lineItems: [
          {
            description: 'Diagnostic Fee',
            defaultQuantity: 1,
            defaultUnitPriceCents: 8900,
            taxable: true,
            sortOrder: 0,
          },
        ],
      });
      expect(result.valid).toBe(true);
    });

    it('accepts template with optional line item category', () => {
      const result = validateProposalPayload('onboarding_estimate_template', {
        verticalType: 'hvac',
        categoryId: 'maintenance',
        templateName: 'Tune-up',
        lineItems: [
          {
            description: 'Labor',
            category: 'labor',
            defaultQuantity: 1,
            defaultUnitPriceCents: 8500,
            taxable: true,
            sortOrder: 0,
          },
          {
            description: 'Filter',
            category: 'material',
            defaultQuantity: 1,
            defaultUnitPriceCents: 2500,
            taxable: true,
            sortOrder: 1,
          },
        ],
      });
      expect(result.valid).toBe(true);
    });

    it('rejects template with empty line items', () => {
      const result = validateProposalPayload('onboarding_estimate_template', {
        verticalType: 'hvac',
        categoryId: 'diagnostic',
        templateName: 'Diagnostic',
        lineItems: [],
      });
      expect(result.valid).toBe(false);
    });

    it('rejects negative unit price', () => {
      const result = validateProposalPayload('onboarding_estimate_template', {
        verticalType: 'hvac',
        categoryId: 'diagnostic',
        templateName: 'Diagnostic',
        lineItems: [
          {
            description: 'Fee',
            defaultQuantity: 1,
            defaultUnitPriceCents: -100,
            taxable: true,
            sortOrder: 0,
          },
        ],
      });
      expect(result.valid).toBe(false);
    });
  });

  describe('onboarding_team_member', () => {
    it('accepts valid team member payload', () => {
      const result = validateProposalPayload('onboarding_team_member', {
        name: 'Marcus',
        role: 'technician',
      });
      expect(result.valid).toBe(true);
    });

    it('accepts dispatcher role', () => {
      const result = validateProposalPayload('onboarding_team_member', {
        name: 'Linda',
        role: 'dispatcher',
      });
      expect(result.valid).toBe(true);
    });

    it('rejects invalid role', () => {
      const result = validateProposalPayload('onboarding_team_member', {
        name: 'Eve',
        role: 'accountant',
      });
      expect(result.valid).toBe(false);
    });

    it('rejects empty name', () => {
      const result = validateProposalPayload('onboarding_team_member', {
        name: '',
        role: 'technician',
      });
      expect(result.valid).toBe(false);
    });

    // `email` is the proposal's missingFields gate key
    // (orchestration/onboarding-conversation.ts). While the schema stayed
    // silent about it, `editProposal` accepted ANY non-empty string —
    // `clearSatisfiedMissingFields` lifted the gate, approval proceeded, and
    // `PendingInvitationRepository.create`'s anchored EMAIL_RE then refused
    // the address at execution: `execution_failed` after the UI said the gate
    // was satisfied. The rule below is `inviteUserSchema`'s
    // (routes/users.ts) verbatim, so the review-card path and
    // POST /api/users/invitations cannot drift on what an address is.
    it('accepts a well-formed email on the gate key', () => {
      const result = validateProposalPayload('onboarding_team_member', {
        name: 'Carlos',
        role: 'technician',
        email: 'carlos@example.com',
      });
      expect(result.valid).toBe(true);
    });

    it.each([
      ['a bare first name (the exact typo from the review)', 'carlos'],
      ['a missing domain', 'carlos@'],
      ['a missing local part', '@example.com'],
      ['an internal space', 'car los@example.com'],
      ['an empty string', ''],
      ['over 320 characters', `${'a'.repeat(320)}@example.com`],
    ])('rejects %s as an email', (_label, email) => {
      const result = validateProposalPayload('onboarding_team_member', {
        name: 'Carlos',
        role: 'technician',
        email,
      });
      expect(result.valid).toBe(false);
    });

    it('accepts a whitespace-padded address (trimmed, like inviteUserSchema)', () => {
      const result = validateProposalPayload('onboarding_team_member', {
        name: 'Carlos',
        role: 'technician',
        email: '  carlos@example.com  ',
      });
      expect(result.valid).toBe(true);
    });

    it('email stays OPTIONAL so voice can still draft the gated proposal', () => {
      const result = validateProposalPayload('onboarding_team_member', {
        name: 'Carlos',
        role: 'technician',
      });
      expect(result.valid).toBe(true);
    });
  });

  describe('onboarding_schedule', () => {
    it('accepts valid schedule payload', () => {
      const result = validateProposalPayload('onboarding_schedule', {
        workingHours: [
          {
            days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
            startTime: '08:00',
            endTime: '17:00',
          },
        ],
      });
      expect(result.valid).toBe(true);
    });

    it('accepts schedule with emergency SLA', () => {
      const result = validateProposalPayload('onboarding_schedule', {
        workingHours: [
          {
            days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
            startTime: '08:00',
            endTime: '17:00',
          },
        ],
        emergencySLA: {
          hoursTarget: 4,
          isGuarantee: false,
        },
      });
      expect(result.valid).toBe(true);
    });

    it('rejects empty working hours', () => {
      const result = validateProposalPayload('onboarding_schedule', {
        workingHours: [],
      });
      expect(result.valid).toBe(false);
    });

    it('rejects invalid time format', () => {
      const result = validateProposalPayload('onboarding_schedule', {
        workingHours: [
          {
            days: ['monday'],
            startTime: '8am',
            endTime: '5pm',
          },
        ],
      });
      expect(result.valid).toBe(false);
    });
  });
});

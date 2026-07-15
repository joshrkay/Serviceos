import { describe, expect, it } from 'vitest';
import { InMemoryTechnicianLocationAuthorizer } from '../../src/telemetry/technician-location-authz';

describe('technician location authz', () => {
  const authorizer = new InMemoryTechnicianLocationAuthorizer();
  const tenantId = '550e8400-e29b-41d4-a716-446655440000';
  const technicianId = '550e8400-e29b-41d4-a716-446655440020';
  const otherTechnicianId = '550e8400-e29b-41d4-a716-446655440021';

  it('allows technician to submit for their canonical users.id only', async () => {
    await expect(
      authorizer.canSubmitForTechnician(
        {
          userId: 'user_tech_clerk',
          canonicalUserId: technicianId,
          sessionId: 's1',
          tenantId,
          role: 'technician',
        },
        technicianId,
      )
    ).resolves.toBe(true);

    await expect(
      authorizer.canSubmitForTechnician(
        {
          userId: 'user_tech_clerk',
          canonicalUserId: technicianId,
          sessionId: 's1',
          tenantId,
          role: 'technician',
        },
        otherTechnicianId,
      )
    ).resolves.toBe(false);
  });

  it('fails closed without a canonical identity', async () => {
    await expect(
      authorizer.canSubmitForTechnician(
        { userId: 'user_tech_clerk', sessionId: 's1', tenantId, role: 'technician' },
        technicianId,
      ),
    ).resolves.toBe(false);
  });

  it('allows dispatcher submissions', async () => {
    await expect(
      authorizer.canSubmitForTechnician(
        { userId: 'dispatcher-1', sessionId: 's1', tenantId, role: 'dispatcher' },
        'tech-1'
      )
    ).resolves.toBe(true);
  });
});

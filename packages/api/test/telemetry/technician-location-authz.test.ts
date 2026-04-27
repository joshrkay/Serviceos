import { describe, expect, it } from 'vitest';
import { InMemoryTechnicianLocationAuthorizer } from '../../src/telemetry/technician-location-authz';

describe('technician location authz', () => {
  const authorizer = new InMemoryTechnicianLocationAuthorizer();
  const tenantId = '550e8400-e29b-41d4-a716-446655440000';

  it('allows technician to submit for self only', async () => {
    await expect(
      authorizer.canSubmitForTechnician(
        { userId: 'tech-1', sessionId: 's1', tenantId, role: 'technician' },
        'tech-1'
      )
    ).resolves.toBe(true);

    await expect(
      authorizer.canSubmitForTechnician(
        { userId: 'tech-1', sessionId: 's1', tenantId, role: 'technician' },
        'tech-2'
      )
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

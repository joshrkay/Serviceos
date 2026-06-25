import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, vi, beforeEach } from 'vitest';
import { PortalRequestService } from '../PortalRequestService';
import { PortalBookAppointment } from '../PortalBookAppointment';
import { PortalSlotPicker } from '../PortalSlotPicker';
import { expectTenantNeutral } from '../../../components/customer/tenantNeutralContract';

/**
 * Tenant-neutral class contract for the three portal form pages (U13i),
 * whose inputs/textareas were migrated to the kit with the neutral focus
 * override. PortalBookAppointment and PortalSlotPicker have no other test.
 */
describe('Portal form pages — tenant-neutral class contract', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('PortalRequestService stays neutral', async () => {
    const { container } = render(<PortalRequestService token="tok-1" />);
    await screen.findByLabelText(/what do you need help with/i);
    expectTenantNeutral(container.innerHTML);
  });

  it('PortalSlotPicker stays neutral', async () => {
    const { container } = render(
      <PortalSlotPicker token="tok-1" confirmLabel="Confirm" onConfirm={vi.fn()} />,
    );
    await screen.findByLabelText(/from/i);
    expectTenantNeutral(container.innerHTML);
  });

  it('PortalBookAppointment stays neutral', async () => {
    const { container } = render(<PortalBookAppointment token="tok-1" />);
    await screen.findByLabelText(/what do you need help with/i);
    expectTenantNeutral(container.innerHTML);
  });
});

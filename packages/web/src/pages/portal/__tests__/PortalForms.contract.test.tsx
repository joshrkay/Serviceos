import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, vi, beforeEach } from 'vitest';
import { PortalRequestService } from '../PortalRequestService';
import { PortalBookAppointment } from '../PortalBookAppointment';
import { PortalSlotPicker } from '../PortalSlotPicker';
import { expectNoRawPalette } from '../../../components/customer/rawPaletteContract';

/**
 * Tenant-neutral class contract for the three portal form pages (U13i),
 * whose inputs/textareas were migrated to the kit with the neutral focus
 * override. PortalBookAppointment and PortalSlotPicker have no other test.
 */
describe('Portal form pages — no-raw-palette class contract', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('PortalRequestService renders no raw palette', async () => {
    const { container } = render(<PortalRequestService token="tok-1" />);
    await screen.findByLabelText(/what do you need help with/i);
    expectNoRawPalette(container.innerHTML);
  });

  it('PortalSlotPicker renders no raw palette', async () => {
    const { container } = render(
      <PortalSlotPicker token="tok-1" confirmLabel="Confirm" onConfirm={vi.fn()} />,
    );
    await screen.findByLabelText(/from/i);
    expectNoRawPalette(container.innerHTML);
  });

  it('PortalBookAppointment renders no raw palette', async () => {
    const { container } = render(<PortalBookAppointment token="tok-1" />);
    await screen.findByLabelText(/what do you need help with/i);
    expectNoRawPalette(container.innerHTML);
  });
});

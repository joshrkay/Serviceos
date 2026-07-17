import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/api-fetch', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '../../utils/api-fetch';
import { CancelNoShowSheet } from './CancelNoShowSheet';
import type { Job } from '../../types/job-ui';

const mockApiFetch = vi.mocked(apiFetch);

const job: Job = {
  id: 'j1',
  jobNumber: '1001',
  customer: 'Alice Smith',
  customerId: 'c1',
  address: '123 Main St',
  serviceType: 'HVAC',
  status: 'Active',
  priority: 'Normal',
  description: 'Fix AC',
  statusHistory: [],
  activity: [],
  materials: [],
};

function renderSheet(onClose = vi.fn()) {
  render(
    <CancelNoShowSheet
      job={job}
      customerName="Alice Smith"
      customerPhone="5125550001"
      customerId="c1"
      onClose={onClose}
    />,
  );
  return onClose;
}

/** Walk the sheet to the confirm step and submit a customer cancellation. */
function submitCancel() {
  fireEvent.click(screen.getByText('Customer Canceled'));
  fireEvent.click(screen.getByRole('button', { name: 'No longer needed' }));
  fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
  fireEvent.click(screen.getByRole('button', { name: /Confirm and cancel/ }));
}

describe('CancelNoShowSheet (no appointment — job transition path)', () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("posts the API-canonical status 'canceled' (single L) with a reason", async () => {
    mockApiFetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    renderSheet();

    submitCancel();

    await waitFor(() =>
      expect(screen.getByText(/Job marked as Canceled/)).toBeInTheDocument(),
    );

    const [url, init] = mockApiFetch.mock.calls[0];
    expect(url).toBe('/api/jobs/j1/transition');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(init?.body as string);
    expect(body.status).toBe('canceled');
    expect(body.reason).toMatch(/\S/);
    expect(body.reason).toContain('No longer needed');
  });

  it('surfaces a 400 as an error instead of closing as success', async () => {
    mockApiFetch.mockResolvedValue(
      new Response(JSON.stringify({ message: 'Invalid transition from completed to canceled' }), { status: 400 }),
    );
    const onClose = renderSheet();

    submitCancel();

    await waitFor(() =>
      expect(screen.getByText('Invalid transition from completed to canceled')).toBeInTheDocument(),
    );
    // Back on the reason step, not the success screen.
    expect(screen.queryByText(/Job marked as/)).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});

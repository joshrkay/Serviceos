// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  convertLead: vi.fn(),
  onConverted: vi.fn(),
  onClose: vi.fn(),
}));

vi.mock('../api/leads', () => ({
  convertLead: (...args: unknown[]) => h.convertLead(...args),
}));

// eslint-disable-next-line import/first
import { ConvertLeadSheet } from './ConvertLeadSheet';

const client = vi.fn();

function renderSheet(initial?: Record<string, string>) {
  return render(
    createElement(ConvertLeadSheet, {
      visible: true,
      onClose: h.onClose,
      client,
      leadId: 'lead-1',
      initial,
      onConverted: h.onConverted,
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.convertLead.mockResolvedValue({ customerId: 'cust-9' });
});

afterEach(() => cleanup());

describe('ConvertLeadSheet', () => {
  it('converts with the entered address and returns the new customer id', async () => {
    const { getByLabelText, getByRole } = renderSheet();

    fireEvent.change(getByLabelText('Street'), { target: { value: '12 Oak' } });
    fireEvent.change(getByLabelText('City'), { target: { value: 'Austin' } });
    fireEvent.change(getByLabelText('State'), { target: { value: 'TX' } });
    fireEvent.change(getByLabelText('Postal code'), { target: { value: '78701' } });
    fireEvent.click(getByRole('button', { name: 'Convert to customer' }));

    await waitFor(() => expect(h.convertLead).toHaveBeenCalled());
    expect(h.convertLead).toHaveBeenCalledWith(client, 'lead-1', {
      street1: '12 Oak',
      street2: undefined,
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
    });
    expect(h.onConverted).toHaveBeenCalledWith('cust-9');
  });

  it('keeps convert disabled until the required fields are filled', () => {
    const { getByLabelText, getByRole } = renderSheet({ street1: '12 Oak', city: 'Austin' });
    // State + postal still blank → still disabled.
    fireEvent.click(getByRole('button', { name: 'Convert to customer' }));
    expect(h.convertLead).not.toHaveBeenCalled();
    // Pre-filled fields come through from `initial`.
    expect((getByLabelText('Street') as HTMLInputElement).value).toBe('12 Oak');
  });
});

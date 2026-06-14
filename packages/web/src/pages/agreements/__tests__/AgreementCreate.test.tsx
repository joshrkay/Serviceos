import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgreementCreate } from '../AgreementCreate';

vi.mock('../../../lib/apiClient', () => ({
  useApiClient: () => vi.fn(),
  isPublicApiPath: () => false,
  shouldInjectAuth: () => true,
  PUBLIC_API_PREFIXES: [],
}));

const mockCreate = vi.fn();
vi.mock('../../../api/agreements', () => ({
  agreementsApi: {
    create: (...args: unknown[]) => mockCreate(...args),
  },
}));

function fillBaseFields(): void {
  fireEvent.change(screen.getByLabelText('Customer ID'), {
    target: { value: '11111111-1111-4111-8111-111111111111' },
  });
  fireEvent.change(screen.getByLabelText('Agreement name'), {
    target: { value: 'Gold Membership' },
  });
}

describe('AgreementCreate — membership auto-renew', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue({ id: 'a1' });
  });

  it('reveals the renewal-term field only when auto-renew is on and submits it', async () => {
    render(<AgreementCreate />);
    fillBaseFields();
    fireEvent.change(screen.getByLabelText('Ends on'), { target: { value: '2027-01-01' } });

    // Term field is hidden until auto-renew is enabled.
    expect(screen.queryByLabelText('Renewal term months')).toBeNull();
    fireEvent.click(screen.getByLabelText('Auto-renew membership'));
    expect(screen.getByLabelText('Renewal term months')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Create Agreement'));

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockCreate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        autoRenew: true,
        renewalTermMonths: 12,
        endsOn: '2027-01-01',
      }),
    );
  });

  it('blocks auto-renew without an end date and does not call the API', async () => {
    render(<AgreementCreate />);
    fillBaseFields();
    fireEvent.click(screen.getByLabelText('Auto-renew membership'));
    // endsOn intentionally left empty.
    fireEvent.click(screen.getByText('Create Agreement'));

    await screen.findByText(/needs an end date/i);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('sends autoRenew=false and a 0 member discount for a plain agreement', async () => {
    render(<AgreementCreate />);
    fillBaseFields();
    fireEvent.click(screen.getByText('Create Agreement'));

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockCreate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ autoRenew: false, memberDiscountBps: 0 }),
    );
  });

  it('converts the member discount percent to basis points', async () => {
    render(<AgreementCreate />);
    fillBaseFields();
    fireEvent.change(screen.getByLabelText('Member discount percent'), { target: { value: '10' } });
    fireEvent.click(screen.getByText('Create Agreement'));

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockCreate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ memberDiscountBps: 1000 }),
    );
  });
});

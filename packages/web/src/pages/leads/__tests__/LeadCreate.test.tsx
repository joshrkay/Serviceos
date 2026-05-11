import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { LeadCreate } from '../LeadCreate';

vi.mock('../../../utils/api-fetch', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../../../utils/api-fetch';

describe('Leads — LeadCreate', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('converts a two-decimal dollar value into integer cents', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ id: 'lead-1' }),
    } as unknown as Response);

    render(<LeadCreate />);

    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Taylor' } });
    fireEvent.change(screen.getByLabelText('Estimated value (USD)'), { target: { value: '12.34' } });
    fireEvent.click(screen.getByRole('button', { name: /create lead/i }));

    await waitFor(() => {
      const body = JSON.parse(vi.mocked(apiFetch).mock.calls[0][1]?.body as string);
      expect(body.estimatedValueCents).toBe(1234);
    });
  });

  it('rejects estimated values with more than two decimal places', async () => {
    render(<LeadCreate />);

    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Taylor' } });
    fireEvent.change(screen.getByLabelText('Estimated value (USD)'), { target: { value: '12.345' } });
    fireEvent.click(screen.getByRole('button', { name: /create lead/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/two decimal places/i);
    expect(vi.mocked(apiFetch)).not.toHaveBeenCalled();
  });
});

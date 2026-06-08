import { render, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('../../../../lib/apiClient', () => ({ useApiClient: () => apiFetchMock }));

import { IdentityStep } from './IdentityStep';

describe('IdentityStep — business profile extras (feature 2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiFetchMock.mockImplementation(async (path: string) => {
      // pre-load (/api/settings/) returns an empty profile; everything else (the PUT) ok
      return { ok: true, json: async () => ({}) };
    });
  });

  it('submits service address, ZIP codes, and services in the identity payload', async () => {
    render(<IdentityStep onSaved={() => {}} />);

    // Pre-load resolves and the form renders (business name input present).
    await waitFor(() => expect(screen.getByPlaceholderText('M&R Mechanical')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('M&R Mechanical'), { target: { value: 'Acme HVAC' } });
    fireEvent.change(screen.getByPlaceholderText('123 Main St, Phoenix AZ'), { target: { value: '123 Main St' } });
    fireEvent.change(screen.getByPlaceholderText('78701, 78702, 78703'), { target: { value: '78701, 78702' } });
    fireEvent.change(screen.getByPlaceholderText('AC repair, furnace install, maintenance plans'), {
      target: { value: 'AC repair, furnace install' },
    });

    fireEvent.click(screen.getByRole('button', { name: /Save and continue/i }));

    await waitFor(() =>
      expect(apiFetchMock.mock.calls.some((c) => c[0] === '/api/onboarding/identity')).toBe(true),
    );
    const put = apiFetchMock.mock.calls.find((c) => c[0] === '/api/onboarding/identity')!;
    const body = JSON.parse((put[1] as RequestInit).body as string);
    expect(body.businessName).toBe('Acme HVAC');
    expect(body.serviceAddress).toBe('123 Main St');
    expect(body.serviceAreaZips).toEqual(['78701', '78702']);
    expect(body.servicesOffered).toEqual(['AC repair', 'furnace install']);
  });
});

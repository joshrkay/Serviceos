/**
 * #875 — the Templates & Customization "Re-run your setup conversation"
 * prompt must deep-link /onboarding?rerun=1 so OnboardingShell's
 * completion gate lets the explicit re-run through instead of bouncing
 * home.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

const apiFetchMock = vi.fn();
vi.mock('../../utils/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('@clerk/clerk-react', () => ({
  useUser: () => ({ user: null, isLoaded: true, isSignedIn: true }),
}));

vi.mock('../../hooks/useMe', () => ({
  useMe: () => ({
    me: { role: 'owner', permissions: [] },
    isLoading: false,
    error: null,
    switchMode: vi.fn(),
    refetch: vi.fn(),
  }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { TemplatesPage } from './TemplatesPage';

function OnboardingProbe() {
  const location = useLocation();
  return <div data-testid="onboarding-probe">{location.search}</div>;
}

describe('TemplatesPage re-run entry point (#875)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
      text: async () => '{}',
    } as unknown as Response);
  });

  it('the re-run prompt navigates to /onboarding?rerun=1', async () => {
    render(
      <MemoryRouter initialEntries={['/settings/templates']}>
        <Routes>
          <Route path="/settings/templates" element={<TemplatesPage />} />
          <Route path="/onboarding" element={<OnboardingProbe />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByText('Re-run your setup conversation'));
    expect(await screen.findByTestId('onboarding-probe')).toHaveTextContent('?rerun=1');
  });
});

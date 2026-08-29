/**
 * #875 — the Settings "Re-run setup assistant" banner must deep-link
 * /onboarding?rerun=1 so OnboardingShell's completion gate lets the
 * explicit re-run through instead of bouncing home.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

const apiFetchMock = vi.fn();
vi.mock('../../utils/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('../../api/settings', () => ({
  fetchLanguageSettings: vi.fn(async () => ({ defaultLanguage: 'en' })),
  updateLanguageSettings: vi.fn(),
}));

vi.mock('../../api/integrations', () => ({
  fetchIntegrations: vi.fn(async () => []),
}));

vi.mock('../../hooks/useMe', () => ({ useMe: () => ({ me: null }) }));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { SettingsPage } from './SettingsPage';

function OnboardingProbe() {
  const location = useLocation();
  return <div data-testid="onboarding-probe">{location.search}</div>;
}

describe('SettingsPage re-run entry point (#875)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
      text: async () => '{}',
    } as unknown as Response);
  });

  it('the banner navigates to /onboarding?rerun=1', async () => {
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <Routes>
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/onboarding" element={<OnboardingProbe />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText('Re-run setup assistant'));
    expect(await screen.findByTestId('onboarding-probe')).toHaveTextContent('?rerun=1');
  });
});

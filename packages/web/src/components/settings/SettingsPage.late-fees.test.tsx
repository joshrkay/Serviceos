/**
 * #1143 (row 8.10) — the owner reaches the late-fee policy from Settings →
 * Payments & billing, next to Deposit rules and Discount policy. Before this
 * no Settings row (or any other surface) could set it.
 */
import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';

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

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { SettingsPage } from './SettingsPage';

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  const ok = init.ok ?? true;
  return {
    ok,
    status: init.status ?? (ok ? 200 : 500),
    statusText: ok ? 'OK' : 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('SettingsPage — Late fees (#1143)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/settings') return jsonResponse({});
      if (url === '/api/onboarding/status') return jsonResponse({ voiceAgentLive: false });
      if (url === '/api/settings/dunning') {
        return jsonResponse({
          configured: true,
          enabled: true,
          reminderSteps: [],
          lateFeeType: 'flat',
          lateFeeValueCents: 2500,
          lateFeeGraceDays: 10,
          lateFeeMaxCents: null,
        });
      }
      return jsonResponse({}, { ok: false, status: 404 });
    });
  });

  it('lists "Late fees" under Payments & billing and opens the policy sheet loaded from /api/settings/dunning', async () => {
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );

    const row = (await screen.findByText('Late fees')).closest('button')!;
    expect(row).toBeTruthy();
    fireEvent.click(row);

    const dialog = await screen.findByRole('dialog', { name: 'Late fees' });
    const flat = (await within(dialog).findByLabelText(/Flat fee/i)) as HTMLInputElement;
    expect(flat.checked).toBe(true);
    expect((within(dialog).getByLabelText(/^Fee amount$/i) as HTMLInputElement).value).toBe('25.00');
    expect(apiFetchMock.mock.calls.some((c) => c[0] === '/api/settings/dunning')).toBe(true);
  });
});

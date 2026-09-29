/**
 * #1402 §13 — Settings has a "Payment terms" row that opens the
 * PaymentTermsSheet (defaultPaymentTermDays).
 */
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';

const apiFetchMock = vi.fn();
vi.mock('../../utils/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const fetchLanguageMock = vi.fn();
vi.mock('../../api/settings', () => ({
  fetchLanguageSettings: () => fetchLanguageMock(),
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

function renderPage(settings: Record<string, unknown>) {
  apiFetchMock.mockImplementation(async (url: string) => {
    if (url === '/api/settings') return jsonResponse(settings);
    if (url === '/api/onboarding/status') return jsonResponse({ voiceAgentLive: false });
    if (url === '/api/onboarding/identity') return jsonResponse({ ok: true });
    return jsonResponse({}, { ok: false, status: 404 });
  });
  fetchLanguageMock.mockResolvedValue({
    defaultLanguage: 'en',
    ttsVoiceEn: null,
    ttsVoiceEs: null,
    autoDetectLanguage: true,
    spanishDispatcherUserIds: [],
  });
  return render(
    <MemoryRouter>
      <SettingsPage />
    </MemoryRouter>,
  );
}

describe('SettingsPage Payment terms row (#1402 §13)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    fetchLanguageMock.mockReset();
  });

  it('opens the payment terms sheet showing the stored terms', async () => {
    renderPage({ businessName: 'Terms Co', defaultPaymentTermDays: 45 });

    fireEvent.click((await screen.findByText('Payment terms')).closest('button')!);

    const dialog = await screen.findByRole('dialog', { name: /Payment terms/i });
    const input = (await within(dialog).findByLabelText(/Payment due within/i)) as HTMLInputElement;
    expect(input.value).toBe('45');
  });
});

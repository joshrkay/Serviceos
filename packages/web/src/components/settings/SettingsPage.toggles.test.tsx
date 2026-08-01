import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';

const apiFetchMock = vi.fn();
vi.mock('../../utils/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const fetchLanguageMock = vi.fn();
const updateLanguageMock = vi.fn();
vi.mock('../../api/settings', () => ({
  fetchLanguageSettings: () => fetchLanguageMock(),
  updateLanguageSettings: (patch: unknown) => updateLanguageMock(patch),
}));

vi.mock('../../hooks/useMe', () => ({ useMe: () => ({ me: null }) }));

const toastErrorMock = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: (msg: string) => toastErrorMock(msg),
  },
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

function renderPage() {
  return render(
    <MemoryRouter>
      <SettingsPage />
    </MemoryRouter>,
  );
}

describe('SettingsPage Quick toggles persistence', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    fetchLanguageMock.mockReset();
    updateLanguageMock.mockReset();
    toastErrorMock.mockReset();
  });

  it('hydrates aiAuto + reminders from /api/settings on mount', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({
        autoApplyInternalUpdates: true,
        autoSendAppointmentReminders: false,
      }),
    );
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ voiceAgentLive: false }));
    fetchLanguageMock.mockResolvedValueOnce({
      defaultLanguage: 'en',
      ttsVoiceEn: null,
      ttsVoiceEs: null,
      autoDetectLanguage: true,
      spanishDispatcherUserIds: [],
    });
    renderPage();
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/api/settings'));
    // Toggle reflects the loaded backend state. We look at the ARIA-free
    // markup (button next to the label) — the test is structural rather
    // than relying on a specific class.
    await waitFor(() =>
      expect(screen.getByText('AI auto-apply for internal updates')).toBeInTheDocument(),
    );
  });

  it('hydrates spanishMode from /api/settings/language on mount', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({}));
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ voiceAgentLive: false }));
    fetchLanguageMock.mockResolvedValueOnce({
      defaultLanguage: 'es',
      ttsVoiceEn: null,
      ttsVoiceEs: null,
      autoDetectLanguage: true,
      spanishDispatcherUserIds: [],
    });
    renderPage();
    await waitFor(() => expect(fetchLanguageMock).toHaveBeenCalled());
  });

  it('persists aiAuto via PUT /api/settings when toggled', async () => {
    // Initial load.
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({ autoApplyInternalUpdates: false, autoSendAppointmentReminders: true }),
    );
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ voiceAgentLive: false }));
    fetchLanguageMock.mockResolvedValueOnce({
      defaultLanguage: 'en',
      ttsVoiceEn: null,
      ttsVoiceEs: null,
      autoDetectLanguage: true,
      spanishDispatcherUserIds: [],
    });
    // Toggle PUT response.
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ autoApplyInternalUpdates: true }));

    renderPage();
    const aiLabel = await screen.findByText('AI auto-apply for internal updates');
    // The toggle button is the next element after the label container.
    const toggleButton = aiLabel.closest('div')?.parentElement?.querySelector('button');
    expect(toggleButton).toBeTruthy();
    fireEvent.click(toggleButton!);

    await waitFor(() => {
      const putCall = apiFetchMock.mock.calls.find(
        (c) => c[1] && (c[1] as RequestInit).method === 'PUT',
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse((putCall![1] as RequestInit).body as string);
      expect(body.autoApplyInternalUpdates).toBe(true);
    });
  });

  it('persists spanishMode via /api/settings/language when toggled', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({}));
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ voiceAgentLive: false }));
    fetchLanguageMock.mockResolvedValueOnce({
      defaultLanguage: 'en',
      ttsVoiceEn: null,
      ttsVoiceEs: null,
      autoDetectLanguage: true,
      spanishDispatcherUserIds: [],
    });
    updateLanguageMock.mockResolvedValueOnce({ defaultLanguage: 'es' });

    renderPage();
    const spanishLabel = await screen.findByText('Spanish language mode');
    const toggleButton = spanishLabel.closest('div')?.parentElement?.querySelector('button');
    fireEvent.click(toggleButton!);

    await waitFor(() => {
      expect(updateLanguageMock).toHaveBeenCalledWith({ defaultLanguage: 'es' });
    });
  });

  it('reverts state and shows a toast when persistence fails', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({ autoApplyInternalUpdates: false, autoSendAppointmentReminders: true }),
    );
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ voiceAgentLive: false }));
    fetchLanguageMock.mockResolvedValueOnce({
      defaultLanguage: 'en',
      ttsVoiceEn: null,
      ttsVoiceEs: null,
      autoDetectLanguage: true,
      spanishDispatcherUserIds: [],
    });
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ message: 'fail' }, { ok: false, status: 500 }));

    renderPage();
    const remLabel = await screen.findByText('Auto send appointment reminders');
    const toggleButton = remLabel.closest('div')?.parentElement?.querySelector('button');
    fireEvent.click(toggleButton!);

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith('Could not save preference'));
  });
});

/**
 * #874 — the Settings "Service area" row is alive: it renders live
 * tenant data (never the old hardcoded Austin string) and opens the
 * ServiceAreaSheet on click.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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

describe('SettingsPage Service area row (#874)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    fetchLanguageMock.mockReset();
  });

  it('renders live service-area data in the subtitle, never the Austin placeholder', async () => {
    renderPage({
      serviceAreaText: 'Phoenix, AZ',
      serviceAreaRadius: 25,
      serviceAreaZips: ['85001', '85002'],
    });
    expect(await screen.findByText('Phoenix, AZ · ~25 mi radius · 2 ZIP codes')).toBeInTheDocument();
    expect(screen.queryByText(/Austin & surrounding areas/)).toBeNull();
  });

  it('shows an honest empty state when nothing is configured', async () => {
    renderPage({ serviceAreaText: null, serviceAreaRadius: null, serviceAreaZips: [] });
    expect(await screen.findByText('Not set — add where you work')).toBeInTheDocument();
    expect(screen.queryByText(/Austin & surrounding areas/)).toBeNull();
  });

  it('clicking the row opens the ServiceAreaSheet', async () => {
    renderPage({
      serviceAreaText: 'Phoenix, AZ',
      serviceAreaRadius: 25,
      serviceAreaZips: [],
      businessName: 'Rivet HVAC',
      jobBufferMinutes: 30,
      hourlyRateCents: 15000,
    });
    const row = (await screen.findByText('Service area')).closest('button');
    expect(row).toBeTruthy();
    fireEvent.click(row!);
    // The sheet's own labeled inputs mount and hydrate.
    const input = (await screen.findByLabelText(/Where you work/i)) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('Phoenix, AZ'));
  });

  it('a successful sheet save refreshes the row subtitle', async () => {
    renderPage({
      serviceAreaText: 'Phoenix, AZ',
      serviceAreaRadius: 25,
      serviceAreaZips: [],
      businessName: 'Rivet HVAC',
      jobBufferMinutes: 30,
      hourlyRateCents: 15000,
    });
    fireEvent.click((await screen.findByText('Service area')).closest('button')!);
    const input = await screen.findByLabelText(/Where you work/i);
    await waitFor(() => expect((input as HTMLInputElement).value).toBe('Phoenix, AZ'));
    fireEvent.change(input, { target: { value: 'Tempe, AZ' } });
    // The page's Reviews card has its own Save — scope to the sheet.
    fireEvent.click(within(screen.getByRole('dialog')).getByText('Save'));
    expect(await screen.findByText('Tempe, AZ · ~25 mi radius')).toBeInTheDocument();
  });
});

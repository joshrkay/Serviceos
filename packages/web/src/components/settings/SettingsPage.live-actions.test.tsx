/**
 * #877 — settings rows that fire live actions are confirm-gated and
 * visually distinct from panel-opening rows:
 * - "AI phone answering" is an explicit switch (role="switch"); the POST
 *   fires only after the ConfirmDialog is confirmed, never on the click.
 * - "Rivet subscription" (Stripe portal handoff) opens a ConfirmDialog
 *   and renders an external-link affordance instead of a chevron.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

const toastErrorMock = vi.fn();
const toastSuccessMock = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (msg: string) => toastSuccessMock(msg),
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

/** Route apiFetch by exact path; unrouted paths soft-fail like prod. */
function routeApi(routes: Record<string, (init?: RequestInit) => Response>) {
  apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const handler = routes[url];
    if (handler) return handler(init);
    return jsonResponse({}, { ok: false, status: 404 });
  });
}

function voiceCalls(path: string) {
  return apiFetchMock.mock.calls.filter((c) => c[0] === path);
}

function renderPage({ voiceLive = false }: { voiceLive?: boolean } = {}) {
  routeApi({
    '/api/settings': () => jsonResponse({}),
    '/api/onboarding/status': () => jsonResponse({ voiceAgentLive: voiceLive }),
    '/api/voice/go-live': () => jsonResponse({ voiceAgentLive: true }),
    '/api/voice/pause': () => jsonResponse({ voiceAgentLive: false }),
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

async function findVoiceSwitch() {
  const el = await screen.findByRole('switch', { name: 'AI phone answering' });
  // Hydration flips `disabled` off once /api/onboarding/status lands.
  await waitFor(() => expect(el).toBeEnabled());
  return el;
}

describe('SettingsPage live-action rows (#877)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    fetchLanguageMock.mockReset();
    toastErrorMock.mockReset();
    toastSuccessMock.mockReset();
  });

  it('renders the voice row as a switch reflecting hydrated state, with an Off badge', async () => {
    renderPage({ voiceLive: false });
    const sw = await findVoiceSwitch();
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('Off')).toBeInTheDocument();
  });

  it('clicking the switch opens a confirm dialog without firing the POST', async () => {
    renderPage({ voiceLive: false });
    fireEvent.click(await findVoiceSwitch());
    expect(await screen.findByText('Turn on AI phone answering?')).toBeInTheDocument();
    expect(voiceCalls('/api/voice/go-live')).toHaveLength(0);
    expect(voiceCalls('/api/voice/pause')).toHaveLength(0);
  });

  it('confirm fires the go-live POST and flips the switch on', async () => {
    renderPage({ voiceLive: false });
    fireEvent.click(await findVoiceSwitch());
    fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'));
    await waitFor(() => expect(voiceCalls('/api/voice/go-live')).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'AI phone answering' })).toHaveAttribute(
        'aria-checked',
        'true',
      ),
    );
    expect(toastSuccessMock).toHaveBeenCalledWith('AI phone answering is on');
  });

  it('cancel closes the dialog and never fires a voice POST', async () => {
    renderPage({ voiceLive: false });
    fireEvent.click(await findVoiceSwitch());
    fireEvent.click(await screen.findByTestId('confirm-dialog-cancel'));
    await waitFor(() =>
      expect(screen.queryByText('Turn on AI phone answering?')).not.toBeInTheDocument(),
    );
    expect(voiceCalls('/api/voice/go-live')).toHaveLength(0);
    expect(voiceCalls('/api/voice/pause')).toHaveLength(0);
  });

  it('pause direction confirms with voicemail copy and fires /api/voice/pause', async () => {
    renderPage({ voiceLive: true });
    const sw = await findVoiceSwitch();
    expect(sw).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(sw);
    expect(await screen.findByText('Turn off AI phone answering?')).toBeInTheDocument();
    expect(
      screen.getByText('Callers will hear voicemail until you turn it back on.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    await waitFor(() => expect(voiceCalls('/api/voice/pause')).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'AI phone answering' })).toHaveAttribute(
        'aria-checked',
        'false',
      ),
    );
  });

  it('a 402 BILLING_REQUIRED go-live gets billing-specific copy, not a mystery failure', async () => {
    renderPage({ voiceLive: false });
    routeApi({
      '/api/voice/go-live': () =>
        jsonResponse(
          { error: 'BILLING_REQUIRED', message: 'Active subscription required' },
          { ok: false, status: 402 },
        ),
    });
    fireEvent.click(await findVoiceSwitch());
    fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'));
    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(
        expect.stringContaining('requires an active subscription'),
      ),
    );
    // The switch stays off — the failed transition never applied.
    expect(screen.getByRole('switch', { name: 'AI phone answering' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('the Rivet subscription row confirm-gates the Stripe portal POST', async () => {
    renderPage();
    const row = (await screen.findByText('Rivet subscription')).closest('button');
    expect(row).toBeTruthy();
    fireEvent.click(row!);
    expect(await screen.findByText('Open the Stripe billing portal?')).toBeInTheDocument();
    expect(voiceCalls('/api/billing/portal-session')).toHaveLength(0);

    routeApi({
      '/api/billing/portal-session': () =>
        jsonResponse(
          { error: 'BILLING_PORTAL_FAILED', message: 'Stripe rejected the request' },
          { ok: false, status: 502 },
        ),
    });
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    await waitFor(() => expect(voiceCalls('/api/billing/portal-session')).toHaveLength(1));
  });

  it('the Rivet subscription row renders an external-link affordance, not a chevron', async () => {
    renderPage();
    const row = (await screen.findByText('Rivet subscription')).closest('button')!;
    expect(row.querySelector('svg.lucide-external-link')).not.toBeNull();
    expect(row.querySelector('svg.lucide-chevron-right')).toBeNull();
    // Panel rows keep the chevron.
    const panelRow = screen.getByText('Payment methods').closest('button')!;
    expect(panelRow.querySelector('svg.lucide-chevron-right')).not.toBeNull();
  });

  // Class-contract (CLAUDE.md): ≥44px tap targets on the controls this
  // change touches — the switch hit area and the section rows.
  it('the switch and section rows clear the 44px tap-target floor', async () => {
    renderPage();
    const sw = await findVoiceSwitch();
    expect(sw.className).toContain('min-h-11');
    expect(sw.className).toContain('min-w-11');
    const row = screen.getByText('Rivet subscription').closest('button')!;
    expect(row.className).toContain('min-h-11');
  });
});

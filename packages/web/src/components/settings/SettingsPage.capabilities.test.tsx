/**
 * #1011 (wayfinder map #995) — the Capabilities controls.
 *
 * Rows 2.6 (vulnerability triage) and 2.7 (dropped-call recovery) were both
 * "Mike cannot turn this on": the per-tenant writer had no route, so only a
 * platform admin could switch them. This is the owner-facing half — and this
 * file is what says an owner can actually reach it.
 *
 * Written in the `SettingsPage.toggles.test.tsx` style.
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

const LANG = {
  defaultLanguage: 'en',
  ttsVoiceEn: null,
  ttsVoiceEs: null,
  autoDetectLanguage: true,
  spanishDispatcherUserIds: [],
};

type Caps = Record<string, { enabled: boolean; source: string; platformFrozen?: boolean }> | null;

/**
 * Route the mount fetches by URL rather than by call order — the capabilities
 * GET races the settings GET and the onboarding-status GET, and an
 * order-dependent mock would be pinning the scheduler, not the component.
 */
function primeMount(opts: { capabilities?: Caps; capabilitiesStatus?: number } = {}) {
  apiFetchMock.mockImplementation((url: string) => {
    if (url === '/api/settings/capabilities') {
      if (opts.capabilitiesStatus && opts.capabilitiesStatus !== 200) {
        return Promise.resolve(
          jsonResponse({ error: 'CAPABILITIES_NOT_CONFIGURED' }, {
            ok: false,
            status: opts.capabilitiesStatus,
          }),
        );
      }
      return Promise.resolve(
        jsonResponse(
          opts.capabilities ?? {
            dropped_call_recovery: { enabled: false, source: 'default', platformFrozen: false },
            voice_vulnerability_triage: { enabled: false, source: 'default', platformFrozen: false },
          },
        ),
      );
    }
    if (url === '/api/settings') return Promise.resolve(jsonResponse({}));
    if (url === '/api/onboarding/status') {
      return Promise.resolve(jsonResponse({ voiceAgentLive: false }));
    }
    return Promise.resolve(jsonResponse({}));
  });
  fetchLanguageMock.mockResolvedValue(LANG);
}

function renderPage() {
  return render(
    <MemoryRouter>
      <SettingsPage />
    </MemoryRouter>,
  );
}

function toggleFor(label: HTMLElement): HTMLButtonElement {
  const button = label.closest('div')?.parentElement?.querySelector('button');
  expect(button).toBeTruthy();
  return button as HTMLButtonElement;
}

function capabilityPut(key: string) {
  return apiFetchMock.mock.calls.find(
    (c) => c[0] === `/api/settings/capabilities/${key}` && (c[1] as RequestInit)?.method === 'PUT',
  );
}

const LABELS = {
  dropped: 'Text back callers who hang up',
  triage: 'Extra care for callers in distress',
} as const;

describe('#1011 — SettingsPage capabilities', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    fetchLanguageMock.mockReset();
    updateLanguageMock.mockReset();
    toastErrorMock.mockReset();
  });

  it('reads both capabilities from GET /api/settings/capabilities on mount', async () => {
    primeMount();
    renderPage();

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith('/api/settings/capabilities'),
    );
    expect(await screen.findByText(LABELS.dropped)).toBeInTheDocument();
    expect(screen.getByText(LABELS.triage)).toBeInTheDocument();
  });

  it('hydrates each switch from its resolved state', async () => {
    primeMount({
      capabilities: {
        dropped_call_recovery: { enabled: true, source: 'tenant', platformFrozen: false },
        voice_vulnerability_triage: { enabled: false, source: 'default', platformFrozen: false },
      },
    });
    renderPage();

    const dropped = await screen.findByText(LABELS.dropped);
    await waitFor(() => expect(toggleFor(dropped).className).toContain('bg-blue-600'));
    expect(toggleFor(screen.getByText(LABELS.triage)).className).toContain('bg-slate-200');
  });

  it('PUTs to /api/settings/capabilities/dropped_call_recovery when switched on', async () => {
    primeMount();
    renderPage();

    fireEvent.click(toggleFor(await screen.findByText(LABELS.dropped)));

    await waitFor(() => {
      const put = capabilityPut('dropped_call_recovery');
      expect(put).toBeDefined();
      expect(JSON.parse((put![1] as RequestInit).body as string)).toEqual({ enabled: true });
    });
  });

  it('PUTs to /api/settings/capabilities/voice_vulnerability_triage when switched on', async () => {
    primeMount();
    renderPage();

    fireEvent.click(toggleFor(await screen.findByText(LABELS.triage)));

    await waitFor(() => {
      const put = capabilityPut('voice_vulnerability_triage');
      expect(put).toBeDefined();
      expect(JSON.parse((put![1] as RequestInit).body as string)).toEqual({ enabled: true });
    });
  });

  it('reverts the switch and toasts when the capability PUT fails', async () => {
    primeMount();
    apiFetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/settings/capabilities/dropped_call_recovery' && init?.method === 'PUT') {
        return Promise.resolve(jsonResponse({ error: 'x' }, { ok: false, status: 500 }));
      }
      if (url === '/api/settings/capabilities') {
        return Promise.resolve(
          jsonResponse({
            dropped_call_recovery: { enabled: false, source: 'default', platformFrozen: false },
            voice_vulnerability_triage: { enabled: false, source: 'default', platformFrozen: false },
          }),
        );
      }
      if (url === '/api/onboarding/status') {
        return Promise.resolve(jsonResponse({ voiceAgentLive: false }));
      }
      return Promise.resolve(jsonResponse({}));
    });
    renderPage();

    const dropped = await screen.findByText(LABELS.dropped);
    fireEvent.click(toggleFor(dropped));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
    await waitFor(() => expect(toggleFor(dropped).className).toContain('bg-slate-200'));
  });

  it('a platform flag that is ON is still the owner\'s to turn OFF', async () => {
    // The 409 rule (routes/settings.ts) fires ONLY for a platform row with
    // `enabled: false`. A platform row that is ON is a ramp, not a freeze —
    // the server accepts the write, so the switch must not be disabled and the
    // row must not claim the capability is turned off platform-wide.
    primeMount({
      capabilities: {
        dropped_call_recovery: { enabled: true, source: 'platform', platformFrozen: false },
        voice_vulnerability_triage: { enabled: false, source: 'default', platformFrozen: false },
      },
    });
    renderPage();

    const dropped = await screen.findByText(LABELS.dropped);
    const button = toggleFor(dropped);
    expect(button.disabled).toBe(false);
    expect(dropped.closest('div')!.textContent).not.toMatch(/platform/i);

    fireEvent.click(button);
    await waitFor(() => {
      const put = capabilityPut('dropped_call_recovery');
      expect(put).toBeDefined();
      expect(JSON.parse((put![1] as RequestInit).body as string)).toEqual({ enabled: false });
    });
  });

  it('D5: a platform-frozen capability is disabled, explained, and not PUT-able', async () => {
    primeMount({
      capabilities: {
        dropped_call_recovery: { enabled: false, source: 'platform', platformFrozen: true },
        voice_vulnerability_triage: { enabled: false, source: 'default', platformFrozen: false },
      },
    });
    renderPage();

    const dropped = await screen.findByText(LABELS.dropped);
    const button = toggleFor(dropped);
    expect(button.disabled).toBe(true);
    // The operator is told WHY it is not theirs to change, rather than clicking
    // a dead switch — the server would answer 409.
    expect(dropped.closest('div')!.textContent).toMatch(/platform/i);

    fireEvent.click(button);
    await waitFor(() => expect(capabilityPut('dropped_call_recovery')).toBeUndefined());
  });

  it('hides the capabilities block entirely when the API reports it unconfigured (503)', async () => {
    primeMount({ capabilitiesStatus: 503 });
    renderPage();

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith('/api/settings/capabilities'),
    );
    // Better to show nothing than a pair of switches that silently do nothing.
    expect(screen.queryByText(LABELS.dropped)).toBeNull();
    expect(screen.queryByText(LABELS.triage)).toBeNull();
  });
});

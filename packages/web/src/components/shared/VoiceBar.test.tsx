/**
 * U6 — the persistent mic is route-aware: on /onboarding it drives the
 * conversational Onboarding Agent (POST /api/onboarding/conversation/turn);
 * everywhere else it dispatches to /assistant (unchanged).
 *
 * The send is reached via the suggestion strip (pre-fills the transcript) +
 * Enter, so the test never needs the MediaRecorder capture path.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';

const navigateMock = vi.fn();
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return { ...actual, useNavigate: () => navigateMock };
});

const apiFetchMock = vi.fn();
vi.mock('../../utils/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('../../hooks/useTTS', () => ({ useTTS: () => ({ speak: vi.fn() }) }));

import { VoiceBar } from './VoiceBar';

function renderAt(pathname: string) {
  return render(
    <MemoryRouter initialEntries={[pathname]}>
      <VoiceBar variant="mobile" />
    </MemoryRouter>,
  );
}

/** Click a suggestion chip (pre-fills the transcript) then press Enter to send. */
function sendSuggestion(chipText: string) {
  fireEvent.click(screen.getByRole('button', { name: chipText }));
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
}

describe('VoiceBar — route-aware dispatch', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ sessionId: 's-1', assistantMessage: 'Great!', state: 'collect', completed: false }),
    } as Response);
  });

  it('on /onboarding, sends the transcript to the onboarding agent and does NOT navigate to /assistant', async () => {
    renderAt('/onboarding');
    sendSuggestion('My business is Acme Plumbing');

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/onboarding/conversation/turn');
    const body = JSON.parse((apiFetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.userMessage).toBe('My business is Acme Plumbing');
    // Crucially, no navigation away from the wizard.
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('on an app route, dispatches to /assistant (no onboarding call) — no regression', async () => {
    renderAt('/invoices');
    sendSuggestion('Any overdue invoices?');

    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith('/assistant?q=Any%20overdue%20invoices%3F'),
    );
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

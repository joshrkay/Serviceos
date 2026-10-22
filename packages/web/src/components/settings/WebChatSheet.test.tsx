/**
 * #1737 — Web chat settings sheet. API mocked at apiFetch; also pins the
 * mobile class contract (>=44px targets, no fixed widths that overflow 320px).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectAllTapTargets } from '../../test-utils/tap-target';

const apiFetchMock = vi.fn();
vi.mock('../../utils/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { WebChatSheet, dollarsToCents } from './WebChatSheet';

const SNIPPET = '<script async src="https://api.example.com/api/public/webchat/widget.js" data-token="t.1"></script>';

function settings(over: Record<string, unknown> = {}) {
  return {
    enabled: false,
    killed: false,
    allowedOrigins: ['https://rivera.example.com'],
    dailyTurnCap: 200,
    dailyCostCapCents: 500,
    snippet: SNIPPET,
    available: true,
    usageToday: { turns: 3, costCents: 7 },
    ...over,
  };
}

function ok(data: unknown): Response {
  return { ok: true, status: 200, json: async () => ({ data }) } as unknown as Response;
}

describe('dollarsToCents', () => {
  it('converts to integer cents without floating point', () => {
    expect(dollarsToCents('5')).toBe(500);
    expect(dollarsToCents('5.5')).toBe(550);
    expect(dollarsToCents('$12.05')).toBe(1205);
    expect(dollarsToCents('0.29')).toBe(29);
    expect(dollarsToCents('1.234')).toBeNull();
    expect(dollarsToCents('abc')).toBeNull();
    expect(dollarsToCents('-1')).toBeNull();
  });
});

describe('WebChatSheet', () => {
  beforeEach(() => apiFetchMock.mockReset());

  it('loads settings, shows the snippet and today usage; meets the 44px bar', async () => {
    apiFetchMock.mockResolvedValue(ok(settings()));
    render(<WebChatSheet open onOpenChange={() => {}} />);
    expect((await screen.findByTestId('webchat-snippet') as HTMLTextAreaElement).value).toBe(SNIPPET);
    expect(screen.getByTestId('webchat-status').textContent).toContain('Off');
    expect(screen.getByTestId('webchat-status').textContent).toContain('$0.07');
    expect((screen.getByTestId('webchat-cost-cap') as HTMLInputElement).value).toBe('5.00');
    expectAllTapTargets(screen.getByRole('dialog'), 'Web chat sheet');
  });

  it('toggling on sends enabled:true', async () => {
    apiFetchMock.mockResolvedValueOnce(ok(settings())).mockResolvedValueOnce(ok(settings({ enabled: true })));
    render(<WebChatSheet open onOpenChange={() => {}} />);
    fireEvent.click(await screen.findByTestId('webchat-toggle'));
    await waitFor(() => expect(screen.getByTestId('webchat-status').textContent).toContain('On'));
    const [path, init] = apiFetchMock.mock.calls[1] as [string, RequestInit];
    expect(path).toBe('/api/webchat');
    expect(JSON.parse(String(init.body))).toEqual({ enabled: true });
  });

  it('saves sites and limits as trimmed lines, integer turns and integer cents', async () => {
    apiFetchMock.mockResolvedValueOnce(ok(settings())).mockResolvedValueOnce(ok(settings()));
    render(<WebChatSheet open onOpenChange={() => {}} />);
    fireEvent.change(await screen.findByTestId('webchat-sites'), { target: { value: ' https://a.com \n\nhttps://b.com' } });
    fireEvent.change(screen.getByTestId('webchat-turn-cap'), { target: { value: '50' } });
    fireEvent.change(screen.getByTestId('webchat-cost-cap'), { target: { value: '2.5' } });
    fireEvent.click(screen.getByTestId('webchat-save'));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2));
    const init = apiFetchMock.mock.calls[1]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      allowedOrigins: ['https://a.com', 'https://b.com'],
      dailyTurnCap: 50,
      dailyCostCapCents: 250,
    });
  });

  it('refuses a bad spend limit before calling the API', async () => {
    apiFetchMock.mockResolvedValueOnce(ok(settings()));
    render(<WebChatSheet open onOpenChange={() => {}} />);
    fireEvent.change(await screen.findByTestId('webchat-cost-cap'), { target: { value: 'lots' } });
    fireEvent.click(screen.getByTestId('webchat-save'));
    expect((await screen.findByRole('alert')).textContent).toContain('dollars');
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  it('the pause button sends killed:true; rotating needs a second tap', async () => {
    apiFetchMock
      .mockResolvedValueOnce(ok(settings({ enabled: true })))
      .mockResolvedValueOnce(ok(settings({ enabled: true, killed: true })))
      .mockResolvedValueOnce(ok(settings({ enabled: true, killed: true, snippet: SNIPPET.replace('t.1', 't.2') })));
    render(<WebChatSheet open onOpenChange={() => {}} />);
    fireEvent.click(await screen.findByTestId('webchat-kill'));
    await waitFor(() => expect(screen.getByTestId('webchat-status').textContent).toContain('Paused'));
    expect(JSON.parse(String((apiFetchMock.mock.calls[1]![1] as RequestInit).body))).toEqual({ killed: true });

    fireEvent.click(screen.getByTestId('webchat-rotate'));
    expect(apiFetchMock).toHaveBeenCalledTimes(2); // first tap only asks
    fireEvent.click(screen.getByTestId('webchat-rotate'));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(3));
    expect(apiFetchMock.mock.calls[2]![0]).toBe('/api/webchat/rotate-token');
  });

  it('tells the owner when the account does not have web chat yet and disables the toggle', async () => {
    apiFetchMock.mockResolvedValue(ok(settings({ available: false, snippet: null })));
    render(<WebChatSheet open onOpenChange={() => {}} />);
    expect(await screen.findByTestId('webchat-unavailable')).toBeTruthy();
    expect((screen.getByTestId('webchat-toggle') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('webchat-no-snippet')).toBeTruthy();
  });
});

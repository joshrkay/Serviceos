/**
 * The return from the payment page: /onboarding?billing=ok (or success) after
 * paying, ?billing=cancel after backing out. Real useApiClient, `fetch` stubbed.
 */
import { StrictMode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json } from './__fixtures__/after';
import { useBillingReturn } from './useBillingReturn';

let calls: string[];

function stub(cancel: () => Promise<Response> | Response) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const call = `${init?.method ?? 'GET'} ${String(input)}`;
      calls.push(call);
      if (call === 'POST /api/onboarding/billing/cancel') return Promise.resolve(cancel());
      throw new Error(`unexpected request ${call}`);
    }),
  );
}

function Probe({ refetch }: { refetch: () => Promise<void> }) {
  const notice = useBillingReturn(refetch);
  const { search } = useLocation();
  return (
    <>
      <p data-testid="search">{search}</p>
      <p data-testid="notice">{notice ?? ''}</p>
    </>
  );
}

function renderAt(url: string, refetch = vi.fn(() => Promise.resolve()), strict = false) {
  const tree = (
    <MemoryRouter initialEntries={[url]}>
      <Probe refetch={refetch} />
    </MemoryRouter>
  );
  render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  return refetch;
}

const search = () => screen.getByTestId('search').textContent;
const notice = () => screen.getByTestId('notice').textContent;

describe('useBillingReturn', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('does nothing when the owner did not come back from the payment page', () => {
    stub(() => json(200, { ok: true }));
    const refetch = renderAt('/onboarding?foo=1');
    expect(calls).toEqual([]);
    expect(refetch).not.toHaveBeenCalled();
    expect(notice()).toBe('');
    expect(search()).toBe('?foo=1');
  });

  it.each(['ok', 'success'])('after paying (?billing=%s): clears the param, checks the status again, and says it is confirming', async (value) => {
    stub(() => json(200, { ok: true }));
    const refetch = renderAt(`/onboarding?billing=${value}&keep=me`);
    await waitFor(() => expect(notice()).toBe("Thanks. I'm confirming your trial."));
    expect(search()).toBe('?keep=me');
    expect(refetch).toHaveBeenCalledTimes(1);
    // Paying needs no cleanup call: the webhook ends the pending checkout.
    expect(calls).toEqual([]);
  });

  it('after backing out (?billing=cancel): clears the param, releases the pending checkout, and says the trial has not started', async () => {
    stub(() => json(200, { ok: true }));
    const refetch = renderAt('/onboarding?billing=cancel');
    await waitFor(() => expect(notice()).toBe("No problem. Your trial hasn't started. Start it whenever you're ready."));
    expect(calls).toEqual(['POST /api/onboarding/billing/cancel']);
    expect(search()).toBe('');
    expect(refetch).not.toHaveBeenCalled();
  });

  it('says so when the pending checkout could not be released, so the next tap is not a mystery', async () => {
    stub(() => json(500, { error: 'INTERNAL', message: 'boom' }));
    renderAt('/onboarding?billing=cancel');
    await waitFor(() =>
      expect(notice()).toBe("That checkout was cancelled, but I couldn't clear it yet. Wait a minute, then try again."),
    );
    expect(search()).toBe('');
  });

  it('says so when the connection dropped during the cleanup', async () => {
    stub(() => Promise.reject(new TypeError('Failed to fetch')) as unknown as Response);
    renderAt('/onboarding?billing=cancel');
    await waitFor(() =>
      expect(notice()).toBe("That checkout was cancelled, but I couldn't confirm it. Check your connection, then try again in a minute."),
    );
  });

  it('clears an unknown value without acting on it', async () => {
    stub(() => json(200, { ok: true }));
    const refetch = renderAt('/onboarding?billing=whatever');
    await waitFor(() => expect(search()).toBe(''));
    expect(calls).toEqual([]);
    expect(refetch).not.toHaveBeenCalled();
    expect(notice()).toBe('');
  });

  it('handles one return once, even when React runs the effect twice', async () => {
    stub(() => json(200, { ok: true }));
    renderAt('/onboarding?billing=cancel', undefined, true);
    await waitFor(() => expect(notice()).not.toBe(''));
    expect(calls).toEqual(['POST /api/onboarding/billing/cancel']);
  });
});

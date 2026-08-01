/**
 * WS7 — mid-call REST redirect (createTwilioCallRedirector).
 *
 * Pins the Twilio Calls REST contract: URL, urlencoded body (Url/Method),
 * HTTP-basic auth, and the fail-safe boolean semantics (non-2xx → false,
 * throw → false, never throws).
 */

import { describe, it, expect, vi } from 'vitest';
import { createTwilioCallRedirector } from '../../src/telephony/twilio-call-redirect';

const ACCOUNT_SID = 'AC_start_frame';
const DEFAULT_SID = 'AC_default';
const CALL_SID = 'CA_live_call';
const AUTH_TOKEN = 'tok_secret';
const PUBLIC_BASE = 'https://api.example.com';
const API_BASE = 'https://twilio.test/2010-04-01';

function okFetch() {
  return vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' });
}

describe('WS7 createTwilioCallRedirector', () => {
  it('POSTs the correct URL, urlencoded body, and basic auth; returns true on 2xx', async () => {
    const fetchMock = okFetch();
    const resolveAuthToken = vi.fn().mockResolvedValue(AUTH_TOKEN);
    const redirect = createTwilioCallRedirector({
      resolveAuthToken,
      defaultAccountSid: DEFAULT_SID,
      publicBaseUrl: PUBLIC_BASE,
      apiBaseUrl: API_BASE,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const ok = await redirect({ callSid: CALL_SID, accountSid: ACCOUNT_SID });

    expect(ok).toBe(true);
    // Subaccount SID from the start frame wins over the default.
    expect(resolveAuthToken).toHaveBeenCalledWith(ACCOUNT_SID);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API_BASE}/Accounts/${ACCOUNT_SID}/Calls/${CALL_SID}.json`);
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const expectedAuth = Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64');
    expect(init.headers.Authorization).toBe(`Basic ${expectedAuth}`);
    const params = new URLSearchParams(init.body as string);
    expect(params.get('Url')).toBe(`${PUBLIC_BASE}/api/telephony/voice/gather-fallback`);
    expect(params.get('Method')).toBe('POST');
  });

  it('falls back to defaultAccountSid when the start frame carried none', async () => {
    const fetchMock = okFetch();
    const resolveAuthToken = vi.fn().mockResolvedValue(AUTH_TOKEN);
    const redirect = createTwilioCallRedirector({
      resolveAuthToken,
      defaultAccountSid: DEFAULT_SID,
      publicBaseUrl: PUBLIC_BASE,
      apiBaseUrl: API_BASE,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const ok = await redirect({ callSid: CALL_SID });

    expect(ok).toBe(true);
    expect(resolveAuthToken).toHaveBeenCalledWith(undefined);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API_BASE}/Accounts/${DEFAULT_SID}/Calls/${CALL_SID}.json`);
  });

  it('trims a trailing slash on publicBaseUrl', async () => {
    const fetchMock = okFetch();
    const redirect = createTwilioCallRedirector({
      resolveAuthToken: () => Promise.resolve(AUTH_TOKEN),
      defaultAccountSid: DEFAULT_SID,
      publicBaseUrl: `${PUBLIC_BASE}/`,
      apiBaseUrl: API_BASE,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await redirect({ callSid: CALL_SID, accountSid: ACCOUNT_SID });
    const params = new URLSearchParams(fetchMock.mock.calls[0][1].body as string);
    expect(params.get('Url')).toBe(`${PUBLIC_BASE}/api/telephony/voice/gather-fallback`);
  });

  it('returns false on a non-2xx response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => 'gone' });
    const redirect = createTwilioCallRedirector({
      resolveAuthToken: () => Promise.resolve(AUTH_TOKEN),
      defaultAccountSid: DEFAULT_SID,
      publicBaseUrl: PUBLIC_BASE,
      apiBaseUrl: API_BASE,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(await redirect({ callSid: CALL_SID, accountSid: ACCOUNT_SID })).toBe(false);
  });

  it('returns false (never throws) when fetch throws', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    const redirect = createTwilioCallRedirector({
      resolveAuthToken: () => Promise.resolve(AUTH_TOKEN),
      defaultAccountSid: DEFAULT_SID,
      publicBaseUrl: PUBLIC_BASE,
      apiBaseUrl: API_BASE,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(redirect({ callSid: CALL_SID, accountSid: ACCOUNT_SID })).resolves.toBe(false);
  });

  it('returns false when no auth token resolves (never POSTs)', async () => {
    const fetchMock = okFetch();
    const redirect = createTwilioCallRedirector({
      resolveAuthToken: () => Promise.resolve(undefined),
      defaultAccountSid: DEFAULT_SID,
      publicBaseUrl: PUBLIC_BASE,
      apiBaseUrl: API_BASE,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(await redirect({ callSid: CALL_SID, accountSid: ACCOUNT_SID })).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns false when neither accountSid nor defaultAccountSid is available', async () => {
    const fetchMock = okFetch();
    const resolveAuthToken = vi.fn().mockResolvedValue(AUTH_TOKEN);
    const redirect = createTwilioCallRedirector({
      resolveAuthToken,
      publicBaseUrl: PUBLIC_BASE,
      apiBaseUrl: API_BASE,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(await redirect({ callSid: CALL_SID })).toBe(false);
    expect(resolveAuthToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns false (never throws) when resolveAuthToken throws', async () => {
    const fetchMock = okFetch();
    const redirect = createTwilioCallRedirector({
      resolveAuthToken: () => {
        throw new Error('token lookup exploded');
      },
      defaultAccountSid: DEFAULT_SID,
      publicBaseUrl: PUBLIC_BASE,
      apiBaseUrl: API_BASE,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(redirect({ callSid: CALL_SID, accountSid: ACCOUNT_SID })).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

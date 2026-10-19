import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  searchAvailableNumbers,
  purchasePhoneNumber,
  buildPhoneNumberWebhooks,
  getPhoneNumberWebhooks,
  setPhoneNumberVoiceFallback,
  VOICE_FALLBACK_PATH,
} from '../../src/integrations/twilio/provisioning';

const WEBHOOKS = {
  voiceUrl: 'https://example.com/voice',
  voiceFallbackUrl: 'https://example.com/voice/fallback',
  statusCallbackUrl: 'https://example.com/status',
};

type MockResponse = { ok?: boolean; status?: number; body: unknown };

function mockFetch(...responses: MockResponse[]): ReturnType<typeof vi.fn> {
  const fn = vi.fn();
  for (const r of responses) {
    fn.mockResolvedValueOnce({
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    });
  }
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('searchAvailableNumbers', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('maps Twilio candidates and sends the area code + voice/sms filters', async () => {
    const fetchFn = mockFetch({
      body: {
        available_phone_numbers: [
          { phone_number: '+15125550001', locality: 'Austin', region: 'TX' },
          { phone_number: '+15125550002', locality: 'Austin', region: 'TX' },
        ],
      },
    });

    const numbers = await searchAvailableNumbers('ACmaster', 'token', {
      areaCode: '512',
      limit: 5,
    });

    expect(numbers).toEqual([
      { phoneNumber: '+15125550001', locality: 'Austin', region: 'TX' },
      { phoneNumber: '+15125550002', locality: 'Austin', region: 'TX' },
    ]);
    const calledUrl = String(fetchFn.mock.calls[0][0]);
    expect(calledUrl).toContain('/Accounts/ACmaster/AvailablePhoneNumbers/US/Local.json');
    expect(calledUrl).toContain('AreaCode=512');
    expect(calledUrl).toContain('VoiceEnabled=true');
    expect(calledUrl).toContain('SmsEnabled=true');
    expect(calledUrl).toContain('PageSize=5');
  });

  it('returns an empty list when Twilio has no matches (no throw)', async () => {
    mockFetch({ body: { available_phone_numbers: [] } });
    const numbers = await searchAvailableNumbers('ACx', 'token', { areaCode: '999' });
    expect(numbers).toEqual([]);
  });

  it('returns an empty list (no TypeError) when Twilio omits available_phone_numbers', async () => {
    mockFetch({ body: {} });
    const numbers = await searchAvailableNumbers('ACx', 'token', { areaCode: '512' });
    expect(numbers).toEqual([]);
  });

  it('clamps the result list to the requested limit', async () => {
    mockFetch({
      body: {
        available_phone_numbers: Array.from({ length: 8 }, (_, i) => ({
          phone_number: `+1512555000${i}`,
        })),
      },
    });
    const numbers = await searchAvailableNumbers('ACx', 'token', { limit: 3 });
    expect(numbers).toHaveLength(3);
  });

  it('throws when Twilio returns a non-2xx', async () => {
    mockFetch({ ok: false, status: 401, body: { message: 'auth' } });
    await expect(searchAvailableNumbers('ACx', 'bad', {})).rejects.toThrow(/401/);
  });
});

describe('purchasePhoneNumber (reuses searchAvailableNumbers)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('searches the region area code then orders the first available number', async () => {
    const fetchFn = mockFetch(
      // 1) AvailablePhoneNumbers search (TX -> area code 214)
      { body: { available_phone_numbers: [{ phone_number: '+12145550001' }] } },
      // 2) IncomingPhoneNumbers purchase
      { body: { sid: 'PN123', phone_number: '+12145550001' } },
    );

    const purchased = await purchasePhoneNumber('ACsub', 'token', 'TX', WEBHOOKS);

    expect(purchased).toEqual({ sid: 'PN123', phoneNumber: '+12145550001' });
    expect(String(fetchFn.mock.calls[0][0])).toContain('AreaCode=214');
    expect(String(fetchFn.mock.calls[1][0])).toContain('/IncomingPhoneNumbers.json');
  });
});

describe('purchasePhoneNumber with a preferred (claimed) number', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('orders the requested number directly, skipping the search', async () => {
    const fetchFn = mockFetch(
      // Only the purchase POST — no AvailablePhoneNumbers search GET.
      { body: { sid: 'PN999', phone_number: '+15125559999' } },
    );

    const purchased = await purchasePhoneNumber('ACsub', 'token', null, WEBHOOKS, '+15125559999');

    expect(purchased).toEqual({ sid: 'PN999', phoneNumber: '+15125559999' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(String(url)).toContain('/IncomingPhoneNumbers.json');
    expect(String((init as RequestInit).body)).toContain('PhoneNumber=%2B15125559999');
  });

  it('propagates a purchase failure when the chosen number was taken', async () => {
    mockFetch({ ok: false, status: 400, body: { message: 'unavailable' } });
    await expect(
      purchasePhoneNumber('ACsub', 'token', null, WEBHOOKS, '+15125559999'),
    ).rejects.toThrow(/400/);
  });
});

/**
 * LCR-04 — Twilio does not retry a 5xx voice webhook: with no
 * `VoiceFallbackUrl` on the number, a failed /voice (or a credential-lookup
 * 500 during a database brownout) plays Twilio's generic error and drops the
 * call. Every purchase now carries the fallback, pointed at the static
 * voicemail route, and the backfill helpers below bring existing numbers up.
 */
describe('VoiceFallbackUrl at purchase (LCR-04)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('buildPhoneNumberWebhooks derives the three URLs from one voice base', () => {
    expect(buildPhoneNumberWebhooks('https://voice.example.com/', 'tenant-1')).toEqual({
      voiceUrl: 'https://voice.example.com/api/telephony/voice',
      voiceFallbackUrl: `https://voice.example.com${VOICE_FALLBACK_PATH}`,
      statusCallbackUrl: 'https://voice.example.com/webhooks/twilio/status/tenant-1',
    });
    expect(VOICE_FALLBACK_PATH).toBe('/api/telephony/voice/fallback');
  });

  it('the purchase sends VoiceFallbackUrl with VoiceFallbackMethod=POST next to VoiceUrl', async () => {
    const fetchFn = mockFetch({ body: { sid: 'PN1', phone_number: '+15125550001' } });
    await purchasePhoneNumber('ACsub', 'token', null, WEBHOOKS, '+15125550001');
    const [, init] = fetchFn.mock.calls[0];
    const params = new URLSearchParams(String((init as RequestInit).body));
    expect(params.get('VoiceUrl')).toBe('https://example.com/voice');
    expect(params.get('VoiceFallbackUrl')).toBe('https://example.com/voice/fallback');
    expect(params.get('VoiceFallbackMethod')).toBe('POST');
    expect(params.get('StatusCallback')).toBe('https://example.com/status');
  });

  it('getPhoneNumberWebhooks reads the number\'s current voice URLs', async () => {
    const fetchFn = mockFetch({
      body: {
        sid: 'PN1',
        voice_url: 'https://example.com/voice',
        voice_fallback_url: null,
        voice_fallback_method: 'POST',
      },
    });
    const got = await getPhoneNumberWebhooks('ACsub', 'token', 'PN1');
    expect(got).toEqual({ voiceUrl: 'https://example.com/voice', voiceFallbackUrl: null, voiceFallbackMethod: 'POST' });
    expect(String(fetchFn.mock.calls[0][0])).toBe(
      'https://api.twilio.com/2010-04-01/Accounts/ACsub/IncomingPhoneNumbers/PN1.json',
    );
  });

  it('setPhoneNumberVoiceFallback posts VoiceFallbackUrl + VoiceFallbackMethod=POST to the number', async () => {
    const fetchFn = mockFetch({ body: { sid: 'PN1' } });
    await setPhoneNumberVoiceFallback('ACsub', 'token', 'PN1', 'https://example.com/voice/fallback');
    const [url, init] = fetchFn.mock.calls[0];
    expect(String(url)).toBe('https://api.twilio.com/2010-04-01/Accounts/ACsub/IncomingPhoneNumbers/PN1.json');
    expect((init as RequestInit).method).toBe('POST');
    const params = new URLSearchParams(String((init as RequestInit).body));
    expect(params.get('VoiceFallbackUrl')).toBe('https://example.com/voice/fallback');
    expect(params.get('VoiceFallbackMethod')).toBe('POST');
    // Only the fallback is touched: a backfill must not rewrite VoiceUrl.
    expect(params.has('VoiceUrl')).toBe(false);
  });
});

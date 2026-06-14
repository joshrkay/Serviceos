import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  searchAvailableNumbers,
  purchasePhoneNumber,
} from '../../src/integrations/twilio/provisioning';

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

    const purchased = await purchasePhoneNumber(
      'ACsub',
      'token',
      'TX',
      'https://example.com/voice',
      'https://example.com/status',
    );

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

    const purchased = await purchasePhoneNumber(
      'ACsub',
      'token',
      null,
      'https://example.com/voice',
      'https://example.com/status',
      '+15125559999',
    );

    expect(purchased).toEqual({ sid: 'PN999', phoneNumber: '+15125559999' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(String(url)).toContain('/IncomingPhoneNumbers.json');
    expect(String((init as RequestInit).body)).toContain('PhoneNumber=%2B15125559999');
  });

  it('propagates a purchase failure when the chosen number was taken', async () => {
    mockFetch({ ok: false, status: 400, body: { message: 'unavailable' } });
    await expect(
      purchasePhoneNumber('ACsub', 'token', null, 'v', 's', '+15125559999'),
    ).rejects.toThrow(/400/);
  });
});

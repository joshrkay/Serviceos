/**
 * Hardening sweep 2026-10 — Twilio-supplied media URLs are only ever fetched
 * from Twilio hosts, because the fetch carries HTTP Basic credentials.
 */
import { describe, it, expect, vi } from 'vitest';
import { assertTwilioMediaUrl, isTwilioMediaUrl } from '../../src/telephony/twilio-media-url';
import { fetchRecordingBytes } from '../../src/telephony/recording-webhook';

describe('isTwilioMediaUrl', () => {
  it.each([
    'https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/RE1',
    'https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/MM1/Media/ME1',
    'https://api.us1.twilio.com/2010-04-01/Accounts/AC1/Recordings/RE1',
    'https://API.TWILIO.COM/x',
  ])('accepts %s', (url) => {
    expect(isTwilioMediaUrl(url)).toBe(true);
  });

  it.each([
    ['attacker host', 'https://attacker.example/r'],
    ['lookalike suffix', 'https://api.twilio.com.attacker.example/r'],
    ['lookalike prefix', 'https://nottwilio.com/r'],
    ['plain http', 'http://api.twilio.com/r'],
    ['userinfo smuggling', 'https://api.twilio.com@attacker.example/r'],
    ['not a URL', 'RE123'],
    ['empty', ''],
  ])('rejects %s', (_label, url) => {
    expect(isTwilioMediaUrl(url)).toBe(false);
  });
});

describe('assertTwilioMediaUrl', () => {
  it('names the host but never the path or query in the error', () => {
    expect(() =>
      assertTwilioMediaUrl('https://attacker.example/steal?token=secret', 'RecordingUrl'),
    ).toThrow(/RecordingUrl is not a Twilio URL \(host: attacker\.example\)/);
    expect(() =>
      assertTwilioMediaUrl('https://attacker.example/steal?token=secret', 'RecordingUrl'),
    ).not.toThrow(/secret/);
  });
});

describe('fetchRecordingBytes', () => {
  it('refuses a non-Twilio RecordingUrl before any request is made', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    await expect(
      fetchRecordingBytes('https://attacker.example/r', 'AC1', 'tok', fetchFn),
    ).rejects.toThrow(/not a Twilio URL/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('fetches a Twilio RecordingUrl with Basic auth and without following redirects', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      headers: { get: () => null },
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    })) as unknown as typeof fetch;
    const bytes = await fetchRecordingBytes(
      'https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/RE1',
      'AC1',
      'tok',
      fetchFn,
    );
    expect(bytes.length).toBe(3);
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/RE1.mp3');
    expect(init.redirect).toBe('manual');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('AC1:tok').toString('base64')}`,
    );
  });

  it('treats a redirect as a failed fetch (credential never follows it)', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 302,
      text: async () => '',
    })) as unknown as typeof fetch;
    await expect(
      fetchRecordingBytes('https://api.twilio.com/Recordings/RE1', 'AC1', 'tok', fetchFn),
    ).rejects.toThrow(/fetch failed 302/);
  });
});

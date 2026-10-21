/**
 * Hardening sweep 2026-10 — Twilio-supplied media URLs are only ever fetched
 * from Twilio hosts, because the fetch carries HTTP Basic credentials.
 */
import { describe, it, expect, vi } from 'vitest';
import { assertTwilioMediaUrl, isTwilioMediaUrl } from '../../src/telephony/twilio-media-url';
import { fetchRecordingBytes } from '../../src/telephony/recording-webhook';

const AC = 'AC' + 'a'.repeat(32);
const RE = 'RE' + 'b'.repeat(32);
const MM = 'MM' + 'c'.repeat(32);
const ME = 'ME' + 'd'.repeat(32);
const RECORDING = `https://api.twilio.com/2010-04-01/Accounts/${AC}/Recordings/${RE}`;
const MEDIA = `https://api.twilio.com/2010-04-01/Accounts/${AC}/Messages/${MM}/Media/${ME}`;

describe('isTwilioMediaUrl', () => {
  it.each([
    RECORDING,
    `${RECORDING}.mp3`,
    `${RECORDING}.wav`,
    MEDIA,
    `https://api.us1.twilio.com/2010-04-01/Accounts/${AC}/Recordings/${RE}`,
    `https://API.TWILIO.COM/2010-04-01/Accounts/${AC}/Recordings/${RE}`,
  ])('accepts %s', (url) => {
    expect(isTwilioMediaUrl(url)).toBe(true);
  });

  it.each([
    ['attacker host', 'https://attacker.example/r'],
    ['lookalike suffix', `https://api.twilio.com.attacker.example/2010-04-01/Accounts/${AC}/Recordings/${RE}`],
    ['lookalike prefix', `https://nottwilio.com/2010-04-01/Accounts/${AC}/Recordings/${RE}`],
    ['plain http', `http://api.twilio.com/2010-04-01/Accounts/${AC}/Recordings/${RE}`],
    ['userinfo smuggling', `https://api.twilio.com@attacker.example/2010-04-01/Accounts/${AC}/Recordings/${RE}`],
    ['not a URL', 'RE123'],
    ['empty', ''],
    // Cursor security review on #1744: a Twilio host alone let the platform
    // credential read ANY api.twilio.com resource. Only the two media shapes.
    ['account list disguised as mp3 via query', 'https://api.twilio.com/2010-04-01/Accounts.json?.mp3'],
    ['account resource', `https://api.twilio.com/2010-04-01/Accounts/${AC}.json`],
    ['recordings list', `https://api.twilio.com/2010-04-01/Accounts/${AC}/Recordings.json`],
    ['phone numbers', `https://api.twilio.com/2010-04-01/Accounts/${AC}/IncomingPhoneNumbers.json`],
    ['messages list', `https://api.twilio.com/2010-04-01/Accounts/${AC}/Messages/${MM}.json`],
    ['media list', `https://api.twilio.com/2010-04-01/Accounts/${AC}/Messages/${MM}/Media.json`],
    ['recording with query', `${RECORDING}?Download=true`],
    ['recording with fragment', `${RECORDING}#x`],
    ['recording as json', `${RECORDING}.json`],
    ['missing Accounts segment', `https://api.twilio.com/2010-04-01/Recordings/${RE}`],
    ['dot-segment path', `https://api.twilio.com/2010-04-01/Accounts/${AC}/Recordings/../${AC}.json`],
    ['bare host', 'https://api.twilio.com/'],
  ])('rejects %s', (_label, url) => {
    expect(isTwilioMediaUrl(url)).toBe(false);
  });
});

describe('assertTwilioMediaUrl', () => {
  it('names the host but never the path or query in the error', () => {
    expect(() =>
      assertTwilioMediaUrl('https://attacker.example/steal?token=secret', 'RecordingUrl'),
    ).toThrow(/RecordingUrl is not a Twilio media URL \(host: attacker\.example\)/);
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
    ).rejects.toThrow(/not a Twilio media URL/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('fetches a Twilio RecordingUrl with Basic auth and without following redirects', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      headers: { get: () => null },
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    })) as unknown as typeof fetch;
    const bytes = await fetchRecordingBytes(RECORDING, 'AC1', 'tok', fetchFn);
    expect(bytes.length).toBe(3);
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`${RECORDING}.mp3`);
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
      fetchRecordingBytes(RECORDING, 'AC1', 'tok', fetchFn),
    ).rejects.toThrow(/fetch failed 302/);
  });

  it('refuses to buffer a non-audio response (an API resource is never stored as a recording)', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      headers: { get: (h: string) => (h === 'content-type' ? 'application/json' : null) },
      arrayBuffer: async () => new TextEncoder().encode('{"auth_token":"x"}').buffer,
    })) as unknown as typeof fetch;
    await expect(fetchRecordingBytes(RECORDING, 'AC1', 'tok', fetchFn)).rejects.toThrow(
      /non-audio content-type/,
    );
  });
});

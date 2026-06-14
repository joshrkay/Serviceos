import { describe, it, expect, vi } from 'vitest';
import {
  isAllowedTwilioMediaUrl,
  isAllowedImageType,
  parseInboundMedia,
  downloadTwilioMedia,
  MAX_MMS_MEDIA_BYTES,
} from '../../../src/integrations/twilio/media';

describe('isAllowedTwilioMediaUrl (SSRF guard)', () => {
  it('allows Twilio media hosts over https', () => {
    for (const u of [
      'https://api.twilio.com/2010-04-01/Accounts/AC/Messages/MM/Media/ME',
      'https://media.twiliocdn.com/AC/abc',
      'https://mcs.us1.twilio.com/Media/xyz',
    ]) {
      expect(isAllowedTwilioMediaUrl(u)).toBe(true);
    }
  });

  it('refuses non-Twilio hosts, http, and internal targets (SSRF)', () => {
    for (const u of [
      'http://api.twilio.com/x', // not https
      'https://evil.com/x',
      'https://twilio.com.evil.com/x', // suffix-spoof
      'https://169.254.169.254/latest/meta-data', // cloud metadata
      'https://localhost/x',
      'http://127.0.0.1/x',
      'not a url',
      '',
    ]) {
      expect(isAllowedTwilioMediaUrl(u)).toBe(false);
    }
  });
});

describe('isAllowedImageType', () => {
  it('accepts image types (with codec params stripped)', () => {
    expect(isAllowedImageType('image/jpeg')).toBe(true);
    expect(isAllowedImageType('image/png; charset=binary')).toBe(true);
  });
  it('rejects non-images and missing types', () => {
    expect(isAllowedImageType('application/pdf')).toBe(false);
    expect(isAllowedImageType('text/html')).toBe(false);
    expect(isAllowedImageType(undefined)).toBe(false);
  });
});

describe('parseInboundMedia', () => {
  it('extracts MediaUrl/ContentType pairs by NumMedia', () => {
    const items = parseInboundMedia({
      NumMedia: '2',
      MediaUrl0: 'https://media.twiliocdn.com/a',
      MediaContentType0: 'image/jpeg',
      MediaUrl1: 'https://media.twiliocdn.com/b',
      MediaContentType1: 'image/png',
    });
    expect(items).toEqual([
      { url: 'https://media.twiliocdn.com/a', contentType: 'image/jpeg' },
      { url: 'https://media.twiliocdn.com/b', contentType: 'image/png' },
    ]);
  });
  it('returns [] for a plain SMS (no media)', () => {
    expect(parseInboundMedia({ NumMedia: '0', Body: 'hi' })).toEqual([]);
    expect(parseInboundMedia({ Body: 'hi' })).toEqual([]);
  });
});

function fakeFetch(opts: {
  status?: number;
  contentType?: string;
  contentLength?: string;
  bytes?: Buffer;
}): typeof fetch {
  return vi.fn(async () => {
    const headers = new Map<string, string>();
    if (opts.contentType) headers.set('content-type', opts.contentType);
    if (opts.contentLength) headers.set('content-length', opts.contentLength);
    return {
      ok: (opts.status ?? 200) < 400,
      status: opts.status ?? 200,
      headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
      arrayBuffer: async () => (opts.bytes ?? Buffer.from('img')).buffer.slice(
        (opts.bytes ?? Buffer.from('img')).byteOffset,
        (opts.bytes ?? Buffer.from('img')).byteOffset + (opts.bytes ?? Buffer.from('img')).byteLength,
      ),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('downloadTwilioMedia', () => {
  const SID = 'AC123';
  const TOKEN = 'tok';

  it('refuses an untrusted URL before fetching', async () => {
    const fetchImpl = vi.fn();
    const r = await downloadTwilioMedia('https://evil.com/x', SID, TOKEN, 'image/jpeg', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r).toEqual({ ok: false, reason: 'untrusted_url' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a non-image declared content-type before fetching', async () => {
    const r = await downloadTwilioMedia(
      'https://media.twiliocdn.com/a',
      SID,
      TOKEN,
      'application/pdf',
      { fetchImpl: fakeFetch({ contentType: 'application/pdf' }) },
    );
    expect(r).toEqual({ ok: false, reason: 'not_image' });
  });

  it('downloads an image with basic auth and returns the buffer + type', async () => {
    const bytes = Buffer.from('JPEGDATA');
    const fetchImpl = fakeFetch({ contentType: 'image/jpeg', bytes });
    const r = await downloadTwilioMedia('https://media.twiliocdn.com/a', SID, TOKEN, 'image/jpeg', {
      fetchImpl,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.media.contentType).toBe('image/jpeg');
      expect(r.media.buffer.equals(bytes)).toBe(true);
    }
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const auth = (call[1] as RequestInit).headers as Record<string, string>;
    expect(auth.Authorization).toBe('Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64'));
  });

  it('rejects when the response content-type is not an image', async () => {
    const r = await downloadTwilioMedia('https://media.twiliocdn.com/a', SID, TOKEN, undefined, {
      fetchImpl: fakeFetch({ contentType: 'text/html' }),
    });
    expect(r).toEqual({ ok: false, reason: 'not_image' });
  });

  it('rejects over-size media by Content-Length header', async () => {
    const r = await downloadTwilioMedia('https://media.twiliocdn.com/a', SID, TOKEN, 'image/jpeg', {
      fetchImpl: fakeFetch({ contentType: 'image/jpeg', contentLength: String(MAX_MMS_MEDIA_BYTES + 1) }),
    });
    expect(r).toEqual({ ok: false, reason: 'too_large' });
  });

  it('rejects over-size media even when Content-Length lies (post-download check)', async () => {
    const big = Buffer.alloc(50);
    const r = await downloadTwilioMedia('https://media.twiliocdn.com/a', SID, TOKEN, 'image/jpeg', {
      fetchImpl: fakeFetch({ contentType: 'image/jpeg', bytes: big }),
      maxBytes: 10,
    });
    expect(r).toEqual({ ok: false, reason: 'too_large' });
  });

  it('returns fetch_failed on a non-2xx', async () => {
    const r = await downloadTwilioMedia('https://media.twiliocdn.com/a', SID, TOKEN, 'image/jpeg', {
      fetchImpl: fakeFetch({ status: 404, contentType: 'image/jpeg' }),
    });
    expect(r).toEqual({ ok: false, reason: 'fetch_failed' });
  });
});

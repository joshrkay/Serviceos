import { describe, it, expect } from 'vitest';
import {
  parseSignupAttribution,
  readCookieValue,
  sanitizeSignupAttribution,
  signupAttributionProperties,
} from './signup-attribution.js';

const cookieOf = (value: unknown) => encodeURIComponent(JSON.stringify(value));

describe('parseSignupAttribution', () => {
  it('returns null when neither URL nor cookie carries anything', () => {
    expect(parseSignupAttribution({})).toBeNull();
    expect(parseSignupAttribution({ search: '?foo=bar', cookie: null })).toBeNull();
  });

  it('reads every URL param', () => {
    const attr = parseSignupAttribution({
      search:
        '?utm_source=google&utm_medium=cpc&utm_campaign=spring&utm_content=ad1&utm_term=hvac+software' +
        '&rvt_ref=https%3A%2F%2Fwww.google.com%2Fsearch&rvt_landing=%2Fpricing&rvt_ft_at=2026-10-01',
    });
    expect(attr).toEqual({
      utmSource: 'google',
      utmMedium: 'cpc',
      utmCampaign: 'spring',
      utmContent: 'ad1',
      utmTerm: 'hvac software',
      ref: 'https://www.google.com/search',
      landing: '/pricing',
      firstTouchAt: '2026-10-01',
    });
  });

  it('accepts a URLSearchParams instance', () => {
    expect(parseSignupAttribution({ search: new URLSearchParams({ utm_source: 'x' }) })).toEqual({
      utmSource: 'x',
    });
  });

  it('falls back to the cookie when the URL carries nothing', () => {
    const cookie = cookieOf({
      ref: 'https://news.ycombinator.com/item',
      landing: '/blog/post',
      at: '2026-09-30',
      utm_source: 'hn',
      utm_campaign: 'launch',
    });
    expect(parseSignupAttribution({ search: '', cookie })).toEqual({
      utmSource: 'hn',
      utmCampaign: 'launch',
      ref: 'https://news.ycombinator.com/item',
      landing: '/blog/post',
      firstTouchAt: '2026-09-30',
    });
  });

  it('uses the URL utm set alone when the URL has any utm_* (never mixes with cookie utm)', () => {
    const cookie = cookieOf({ utm_source: 'hn', utm_medium: 'social', utm_campaign: 'launch' });
    expect(parseSignupAttribution({ search: '?utm_source=google', cookie })).toEqual({
      utmSource: 'google',
    });
  });

  it('takes ref/landing/at per field from the URL, else the cookie', () => {
    const cookie = cookieOf({ ref: 'https://a.example/x', landing: '/from-cookie', at: '2026-01-02' });
    expect(parseSignupAttribution({ search: '?rvt_landing=%2Ffrom-url', cookie })).toEqual({
      ref: 'https://a.example/x',
      landing: '/from-url',
      firstTouchAt: '2026-01-02',
    });
  });

  it('falls back to the cookie value when the URL value is invalid', () => {
    const cookie = cookieOf({ landing: '/ok' });
    expect(parseSignupAttribution({ search: '?rvt_landing=not-a-path', cookie })).toEqual({
      landing: '/ok',
    });
  });

  it('strips query and fragment from ref and rejects non-http(s) refs', () => {
    expect(
      parseSignupAttribution({ search: `?rvt_ref=${encodeURIComponent('https://x.com/p?q=secret#frag')}` }),
    ).toEqual({ ref: 'https://x.com/p' });
    expect(parseSignupAttribution({ search: '?rvt_ref=javascript%3Aalert(1)' })).toBeNull();
    expect(parseSignupAttribution({ search: '?rvt_ref=not%20a%20url' })).toBeNull();
    expect(parseSignupAttribution({ search: '?rvt_ref=ftp%3A%2F%2Fx.com%2F' })).toBeNull();
  });

  it('rejects landing paths that do not start with "/"', () => {
    expect(parseSignupAttribution({ search: '?rvt_landing=pricing' })).toBeNull();
  });

  it('rejects malformed and impossible first-touch dates', () => {
    expect(parseSignupAttribution({ search: '?rvt_ft_at=2026-1-1' })).toBeNull();
    expect(parseSignupAttribution({ search: '?rvt_ft_at=2026-02-31' })).toBeNull();
    expect(parseSignupAttribution({ search: '?rvt_ft_at=2026-10-01T00%3A00' })).toBeNull();
  });

  it('bounds strings to 200 chars: truncates utm values, drops over-long ref/landing', () => {
    const long = 'a'.repeat(250);
    const attr = parseSignupAttribution({
      search: `?utm_source=${long}&rvt_landing=/${long}&rvt_ref=https://x.com/${long}`,
    });
    expect(attr).toEqual({ utmSource: 'a'.repeat(200) });
  });

  it('strips control characters and drops blank values', () => {
    expect(parseSignupAttribution({ search: '?utm_source=go%00ogle&utm_medium=%20%20' })).toEqual({
      utmSource: 'google',
    });
  });

  it('ignores a malformed cookie without throwing', () => {
    for (const cookie of ['%E0%A4%A', 'not-json', cookieOf([1, 2]), cookieOf('str'), cookieOf(null)]) {
      expect(() => parseSignupAttribution({ cookie })).not.toThrow();
      expect(parseSignupAttribution({ cookie })).toBeNull();
    }
    expect(parseSignupAttribution({ search: '?utm_source=a', cookie: 'not-json' })).toEqual({
      utmSource: 'a',
    });
  });

  it('ignores non-string cookie fields', () => {
    expect(parseSignupAttribution({ cookie: cookieOf({ utm_source: 5, landing: { x: 1 }, at: 20260101 }) })).toBeNull();
  });
});

describe('sanitizeSignupAttribution', () => {
  it('re-validates a client-supplied object with the same rules', () => {
    expect(
      sanitizeSignupAttribution({
        utmSource: 'google',
        utmMedium: 'x'.repeat(300),
        ref: 'https://evil.example/p?token=abc',
        landing: 'no-slash',
        firstTouchAt: '2026-13-01',
        extra: 'dropped',
      }),
    ).toEqual({ utmSource: 'google', utmMedium: 'x'.repeat(200), ref: 'https://evil.example/p' });
  });

  it('returns null for non-objects and empty results', () => {
    for (const input of [undefined, null, 'str', 42, [], {}, { utmSource: 7 }]) {
      expect(sanitizeSignupAttribution(input)).toBeNull();
    }
  });

  it('is idempotent on its own output', () => {
    const once = parseSignupAttribution({ search: '?utm_source=a&rvt_landing=%2Fb&rvt_ft_at=2026-10-01' });
    expect(sanitizeSignupAttribution(once)).toEqual(once);
  });
});

describe('readCookieValue', () => {
  it('extracts a raw cookie value by exact name', () => {
    expect(readCookieValue('a=1; rvt_ft=%7B%22x%22%3A1%7D; rvt_ft_x=2', 'rvt_ft')).toBe('%7B%22x%22%3A1%7D');
    expect(readCookieValue('rvt_ft_x=2', 'rvt_ft')).toBeNull();
    expect(readCookieValue('', 'rvt_ft')).toBeNull();
    expect(readCookieValue(undefined, 'rvt_ft')).toBeNull();
  });
});

describe('signupAttributionProperties', () => {
  it('flattens to analytics property names, omitting absent fields', () => {
    expect(
      signupAttributionProperties({
        utmSource: 'google',
        utmTerm: 't',
        ref: 'https://www.reddit.com/r/HVAC/comments/abc/',
        landing: '/trades/hvac',
        firstTouchAt: '2026-10-01',
      }),
    ).toEqual({
      utm_source: 'google',
      utm_term: 't',
      signup_referrer_host: 'www.reddit.com',
      signup_landing_section: '/trades',
      signup_first_touch_at: '2026-10-01',
    });
    expect(signupAttributionProperties({ landing: '/' })).toEqual({ signup_landing_section: '/' });
    expect(signupAttributionProperties(null)).toEqual({});
  });
});

describe('review fixes', () => {
  it('a URL utm parameter that fails validation still overrides the cookie campaign', () => {
    const cookie = encodeURIComponent(JSON.stringify({ landing: '/', at: '2026-09-28', utm_source: 'hn' }));
    for (const search of ['?utm_source=', '?utm_source=%00']) {
      expect(parseSignupAttribution({ search, cookie })?.utmSource).toBeUndefined();
    }
  });

  it('strips query and fragment from the landing path, in the parser and the sanitizer', () => {
    expect(parseSignupAttribution({ search: '?rvt_landing=' + encodeURIComponent('/invite/x?email=a@b.co#t') })?.landing).toBe('/invite/x');
    expect(sanitizeSignupAttribution({ landing: '/p?token=s' })?.landing).toBe('/p');
  });
});

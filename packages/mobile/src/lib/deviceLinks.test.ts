import { describe, expect, it } from 'vitest';
import { buildMailtoUrl, buildMapsUrl, buildSmsUrl, buildTelUrl } from './deviceLinks';

describe('buildSmsUrl', () => {
  it('builds an sms: URL from a display phone, stripping punctuation', () => {
    expect(buildSmsUrl('(555) 010-0200')).toBe('sms:5550100200');
  });

  it('preserves a leading + for E.164 numbers', () => {
    expect(buildSmsUrl('+1 555 010 0200')).toBe('sms:+15550100200');
  });

  it('returns null when there is no dialable number', () => {
    expect(buildSmsUrl(null)).toBeNull();
    expect(buildSmsUrl(undefined)).toBeNull();
    expect(buildSmsUrl('')).toBeNull();
    expect(buildSmsUrl('  ')).toBeNull();
    expect(buildSmsUrl('no digits')).toBeNull();
  });
});

describe('buildTelUrl', () => {
  it('builds a tel: URL from a display phone', () => {
    expect(buildTelUrl('555-010-0200')).toBe('tel:5550100200');
    expect(buildTelUrl('+44 20 7946 0000')).toBe('tel:+442079460000');
  });

  it('returns null when there is no dialable number', () => {
    expect(buildTelUrl(undefined)).toBeNull();
    expect(buildTelUrl('()-')).toBeNull();
  });
});

describe('buildMailtoUrl', () => {
  it('builds a mailto: URL from an email', () => {
    expect(buildMailtoUrl('beta@example.com')).toBe('mailto:beta%40example.com');
  });

  it('trims surrounding whitespace', () => {
    expect(buildMailtoUrl('  a@b.co  ')).toBe('mailto:a%40b.co');
  });

  it('returns null when no email is present', () => {
    expect(buildMailtoUrl(null)).toBeNull();
    expect(buildMailtoUrl('')).toBeNull();
    expect(buildMailtoUrl('   ')).toBeNull();
  });
});

describe('buildMapsUrl', () => {
  const address = '1 Main St, Springfield, IL';

  it('opens Apple Maps on iOS', () => {
    expect(buildMapsUrl(address, 'ios')).toBe(
      'http://maps.apple.com/?q=1%20Main%20St%2C%20Springfield%2C%20IL',
    );
  });

  it('uses the geo: scheme on Android so the OS picks the maps app', () => {
    expect(buildMapsUrl(address, 'android')).toBe(
      'geo:0,0?q=1%20Main%20St%2C%20Springfield%2C%20IL',
    );
  });

  it('falls back to a universal Google Maps https link elsewhere', () => {
    expect(buildMapsUrl(address, 'web')).toBe(
      'https://maps.google.com/?q=1%20Main%20St%2C%20Springfield%2C%20IL',
    );
  });

  it('returns null when there is no address', () => {
    expect(buildMapsUrl(null, 'ios')).toBeNull();
    expect(buildMapsUrl('', 'android')).toBeNull();
    expect(buildMapsUrl('   ', 'web')).toBeNull();
  });
});

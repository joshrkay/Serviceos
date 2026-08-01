import { describe, expect, it } from 'vitest';
import { resolveApiBaseUrl } from './env';

// MOB-01 — a production Expo export that forgot EXPO_PUBLIC_API_URL must fail
// fast instead of silently shipping a bundle pointed at http://localhost:3000
// over plaintext HTTP. In dev the localhost default is kept for convenience.
describe('resolveApiBaseUrl', () => {
  it('dev + missing → localhost default', () => {
    expect(resolveApiBaseUrl(undefined, true)).toBe('http://localhost:3000');
    expect(resolveApiBaseUrl('', true)).toBe('http://localhost:3000');
    expect(resolveApiBaseUrl('   ', true)).toBe('http://localhost:3000');
  });

  it('dev + provided → trimmed, trailing slash stripped', () => {
    expect(resolveApiBaseUrl('https://api.example.com/', true)).toBe('https://api.example.com');
  });

  it('production + missing/blank → throws', () => {
    expect(() => resolveApiBaseUrl(undefined, false)).toThrow(/EXPO_PUBLIC_API_URL is required/);
    expect(() => resolveApiBaseUrl('', false)).toThrow(/EXPO_PUBLIC_API_URL is required/);
    expect(() => resolveApiBaseUrl('   ', false)).toThrow(/EXPO_PUBLIC_API_URL is required/);
  });

  it('production + provided → trailing slash stripped', () => {
    expect(resolveApiBaseUrl('https://api.example.com/', false)).toBe('https://api.example.com');
    expect(resolveApiBaseUrl('https://api.example.com', false)).toBe('https://api.example.com');
  });
});

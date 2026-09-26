import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WhisperCache } from '../../src/telephony/whisper-cache';

describe('WhisperCache', () => {
  let cache: WhisperCache;

  beforeEach(() => {
    vi.useFakeTimers();
    cache = new WhisperCache({ ttlMs: 5 * 60 * 1000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores and retrieves whisper text by escalationId', () => {
    cache.set('esc_abc', 'Incoming call from Sarah Chen.', 'tenant-1');
    expect(cache.get('esc_abc')).toEqual({ text: 'Incoming call from Sarah Chen.', tenantId: 'tenant-1' });
  });

  it('returns undefined for unknown id', () => {
    expect(cache.get('nope')).toBeUndefined();
  });

  it('expires entries after TTL', () => {
    cache.set('esc_abc', 'whisper', 'tenant-1');
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    expect(cache.get('esc_abc')).toBeUndefined();
  });

  it('does not expire entries before TTL', () => {
    cache.set('esc_abc', 'whisper', 'tenant-1');
    vi.advanceTimersByTime(4 * 60 * 1000);
    expect(cache.get('esc_abc')?.text).toBe('whisper');
  });

  it('overwriting an entry resets its TTL', () => {
    cache.set('esc_abc', 'first', 'tenant-1');
    vi.advanceTimersByTime(4 * 60 * 1000);
    cache.set('esc_abc', 'second', 'tenant-1');
    vi.advanceTimersByTime(4 * 60 * 1000);
    expect(cache.get('esc_abc')?.text).toBe('second');
  });
});

/**
 * #1402 §18 — the per-recipient SMS volume cap is configurable, with a
 * sensible default. Seam: loadConfig.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { loadConfig, resetConfig } from '../../src/shared/config';

describe('config — per-recipient SMS volume cap (#1402 §18)', () => {
  beforeEach(() => resetConfig());

  it('defaults to 20 customer texts per number per rolling 24 hours', () => {
    const config = loadConfig({ NODE_ENV: 'dev' });
    expect(config.SMS_RECIPIENT_CAP_PER_WINDOW).toBe(20);
    expect(config.SMS_RECIPIENT_CAP_WINDOW_HOURS).toBe(24);
  });

  it('reads overrides; 0 disables the cap', () => {
    const config = loadConfig({
      NODE_ENV: 'dev',
      SMS_RECIPIENT_CAP_PER_WINDOW: '0',
      SMS_RECIPIENT_CAP_WINDOW_HOURS: '12',
    });
    expect(config.SMS_RECIPIENT_CAP_PER_WINDOW).toBe(0);
    expect(config.SMS_RECIPIENT_CAP_WINDOW_HOURS).toBe(12);
  });

  it('rejects a negative cap or a zero-hour window', () => {
    expect(() => loadConfig({ NODE_ENV: 'dev', SMS_RECIPIENT_CAP_PER_WINDOW: '-1' })).toThrow();
    resetConfig();
    expect(() => loadConfig({ NODE_ENV: 'dev', SMS_RECIPIENT_CAP_WINDOW_HOURS: '0' })).toThrow();
  });
});

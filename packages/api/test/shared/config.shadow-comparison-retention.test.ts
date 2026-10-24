/**
 * The shadow-comparison retention window is env-configurable with a default
 * (#1813 follow-up). Seam: loadConfig. The default is the platform default of
 * `tenant_settings.recording_retention_days` (365), the horizon the PRIV-1
 * phase of the recording-retention sweep applies to `ai_runs` prompt and reply
 * content — the closest existing AI-content retention window.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { loadConfig, resetConfig } from '../../src/shared/config';

describe('config — SHADOW_COMPARISON_RETENTION_DAYS', () => {
  beforeEach(() => resetConfig());

  it('defaults to 365 days', () => {
    expect(loadConfig({ NODE_ENV: 'dev' }).SHADOW_COMPARISON_RETENTION_DAYS).toBe(365);
  });

  it('reads an override', () => {
    expect(
      loadConfig({ NODE_ENV: 'dev', SHADOW_COMPARISON_RETENTION_DAYS: '30' }).SHADOW_COMPARISON_RETENTION_DAYS,
    ).toBe(30);
  });

  it.each(['0', '-1', '1.5', 'ninety'])('refuses %j at boot (a window must be a positive whole number of days)', (raw) => {
    expect(() => loadConfig({ NODE_ENV: 'dev', SHADOW_COMPARISON_RETENTION_DAYS: raw })).toThrow(
      /SHADOW_COMPARISON_RETENTION_DAYS/,
    );
  });

  it('accepts up to 36500 days (100 years)', () => {
    expect(
      loadConfig({ NODE_ENV: 'dev', SHADOW_COMPARISON_RETENTION_DAYS: '36500' }).SHADOW_COMPARISON_RETENTION_DAYS,
    ).toBe(36500);
  });

  it.each(['36501', '1e9'])(
    'refuses %j at boot: a window past 100 years is "keep forever" by another name (and 1e9 days puts the horizon outside Postgres\'s timestamp range, failing every sweep)',
    (raw) => {
      expect(() => loadConfig({ NODE_ENV: 'dev', SHADOW_COMPARISON_RETENTION_DAYS: raw })).toThrow(
        /SHADOW_COMPARISON_RETENTION_DAYS/,
      );
    },
  );
});

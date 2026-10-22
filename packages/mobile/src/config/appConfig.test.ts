import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #1603 — hands-free step 3: background audio. A spoken answer must finish
 * with the screen off / the app backgrounded. The native half is config, so
 * this pins the app.json contract the store builds are generated from.
 */
const APP_JSON = path.resolve(__dirname, '../../app.json');

interface ExpoConfig {
  expo: {
    ios?: { infoPlist?: Record<string, unknown> };
    android?: { permissions?: string[] };
  };
}

function loadConfig(): ExpoConfig['expo'] {
  return (JSON.parse(readFileSync(APP_JSON, 'utf8')) as ExpoConfig).expo;
}

describe('app.json — background audio for spoken answers (#1603)', () => {
  it('declares the iOS audio background mode so TTS playback survives backgrounding', () => {
    const modes = loadConfig().ios?.infoPlist?.UIBackgroundModes;
    expect(modes).toContain('audio');
  });
});

describe('app.json — store identity and v1 Terminal scope (D-046)', () => {
  it('uses the same brand identifier on both stores', () => {
    const cfg = loadConfig() as { ios?: { bundleIdentifier?: string }; android?: { package?: string } };
    expect(cfg.ios?.bundleIdentifier).toBe('com.therivetapp.app');
    expect(cfg.android?.package).toBe('com.therivetapp.app');
  });

  it('ships the Terminal plugin without the Tap to Pay entitlement check', () => {
    const cfg = loadConfig() as { plugins?: unknown[] };
    const terminal = cfg.plugins?.find(
      (p): p is [string, Record<string, unknown>] =>
        Array.isArray(p) && p[0] === '@stripe/stripe-terminal-react-native',
    );
    expect(terminal, 'Terminal plugin present').toBeTruthy();
    expect(terminal?.[1]).not.toHaveProperty('tapToPayCheck');
    const strings = JSON.stringify([cfg.plugins, (cfg as { ios?: unknown }).ios]);
    expect(strings).not.toMatch(/tap to pay/i);
  });
});

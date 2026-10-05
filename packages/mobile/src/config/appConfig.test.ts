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

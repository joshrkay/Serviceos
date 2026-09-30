import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * expo-audio 0.3.5 (the SDK 52 line; there is no later 0.3.x) inverts the
 * Android `record()` guard, so a prepared recorder never starts:
 *
 *   Function("record") { ref: AudioRecorder ->
 *     checkRecordingPermission()
 *     if (!ref.isPrepared) {   // ← upstream fixed to `if (ref.isPrepared)` in 0.4.0
 *       ref.record()
 *     }
 *   }
 *
 * On device (Maestro run 36774451613) hold-to-record therefore never records:
 * MediaRecorder is stopped while still PREPARED ("stop called in an invalid
 * state: 8") and the app shows "No audio captured". The postinstall patch
 * applies upstream's 0.4.0 fix to the installed Kotlin source.
 */
const require = createRequire(__filename);
const { patchExpoAudioRecord } = require('../../scripts/patch-expo-audio-record.cjs') as {
  patchExpoAudioRecord: (src: string) => { source: string; changed: boolean; recognized: boolean };
};

// Verbatim from expo-audio 0.3.5 android/src/main/java/expo/modules/audio/AudioModule.kt:333-338
const V035 = `      Function("record") { ref: AudioRecorder ->
        checkRecordingPermission()
        if (!ref.isPrepared) {
          ref.record()
        }
      }
`;
// Verbatim from expo-audio 0.4.0 (upstream fix)
const V040 = `      Function("record") { ref: AudioRecorder ->
        checkRecordingPermission()
        if (ref.isPrepared) {
          ref.record()
        }
      }
`;

describe('patchExpoAudioRecord — Android hold-to-record actually records', () => {
  it('turns 0.3.5\'s inverted guard into upstream\'s 0.4.0 guard', () => {
    const out = patchExpoAudioRecord(V035);
    expect(out.changed).toBe(true);
    expect(out.source).toBe(V040);
  });

  it('leaves an already-fixed source (0.4.0+, or a re-run postinstall) untouched but recognized', () => {
    expect(patchExpoAudioRecord(V040)).toEqual({ source: V040, changed: false, recognized: true });
  });

  it('runs on every install and rewrites the installed AudioModule.kt in place', () => {
    const pkg = JSON.parse(readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
    expect(pkg.scripts.postinstall).toBe('node ./scripts/patch-expo-audio-record.cjs');

    const root = mkdtempSync(path.join(tmpdir(), 'expo-audio-patch-'));
    const kt = path.join(root, 'node_modules/expo-audio/android/src/main/java/expo/modules/audio/AudioModule.kt');
    mkdirSync(path.dirname(kt), { recursive: true });
    writeFileSync(kt, `package expo.modules.audio\n${V035}`);

    const res = spawnSync(process.execPath, [path.resolve(__dirname, '../../scripts/patch-expo-audio-record.cjs')], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
    expect(readFileSync(kt, 'utf8')).toBe(`package expo.modules.audio\n${V040}`);
  });
});

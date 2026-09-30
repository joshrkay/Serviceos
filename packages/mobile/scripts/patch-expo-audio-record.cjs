/**
 * postinstall: apply upstream's expo-audio 0.4.0 Android `record()` fix to the
 * installed expo-audio 0.3.5 (the last SDK 52 release).
 *
 * 0.3.5's AudioModule.kt guards `record()` with `if (!ref.isPrepared)`, so a
 * recorder prepared by `prepareToRecordAsync()` never starts: MediaRecorder is
 * later stopped while still PREPARED and hold-to-record yields no audio on every
 * Android device (Maestro run 36774451613). Upstream fixed it to
 * `if (ref.isPrepared)` in 0.4.0. Drop this script with the Expo SDK upgrade.
 *
 * Test: src/dev/expoAudioRecordPatch.test.ts
 */
const BROKEN = /(Function\("record"\) \{ ref: AudioRecorder ->\s*checkRecordingPermission\(\)\s*if \()!(ref\.isPrepared\) \{)/;

const FIXED = /Function\("record"\) \{ ref: AudioRecorder ->\s*checkRecordingPermission\(\)\s*if \(ref\.isPrepared\) \{/;

function patchExpoAudioRecord(source) {
  if (!BROKEN.test(source)) return { source, changed: false, recognized: FIXED.test(source) };
  return { source: source.replace(BROKEN, '$1$2'), changed: true, recognized: true };
}

module.exports = { patchExpoAudioRecord };

if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(
    process.cwd(),
    'node_modules/expo-audio/android/src/main/java/expo/modules/audio/AudioModule.kt',
  );
  if (!fs.existsSync(file)) process.exit(0);
  const out = patchExpoAudioRecord(fs.readFileSync(file, 'utf8'));
  if (out.changed) {
    fs.writeFileSync(file, out.source);
    console.log('patch-expo-audio-record: applied the 0.4.0 Android record() guard fix');
  } else if (!out.recognized) {
    console.warn(
      'patch-expo-audio-record: expo-audio record() guard not recognised — check whether Android hold-to-record still needs the fix',
    );
  }
}

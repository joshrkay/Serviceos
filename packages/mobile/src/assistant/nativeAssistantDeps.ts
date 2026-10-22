/**
 * U13 — device-only assistant deps: TTS playback via expo-audio.
 *
 * Greenfield playback (the repo used expo-audio only for recording): decode the
 * base64 mp3 to a cache file, flip the iOS audio mode out of record mode, and
 * load/replace a single reused player per turn. Isolated behind the injected
 * `AssistantAudioPlayer` interface so the hook's unit tests never touch audio;
 * excluded from unit coverage and spike-verified on device.
 */

import * as FileSystem from 'expo-file-system/legacy';
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import type { AssistantAudioPlayer } from './useAssistantSession';

let player: AudioPlayer | null = null;
let counter = 0;
// #1603 — the previous clip's file; deleted once the player has moved on so
// per-answer clips (now every memo answer, default on) don't pile up in the
// cache dir until the OS evicts them.
let previousUri: string | null = null;

/** The real TTS player: base64 mp3 → cache file → expo-audio playback. */
export const assistantAudioPlayer: AssistantAudioPlayer = {
  async play(base64: string, shouldPlay?: () => boolean): Promise<void> {
    if (!base64) return;
    const dir = FileSystem.cacheDirectory ?? '';
    const uri = `${dir}assistant-tts-${Date.now()}-${counter++}.mp3`;
    await FileSystem.writeAsStringAsync(uri, base64, {
      encoding: FileSystem.EncodingType.Base64,
    });
    // A caller whose mic may have opened while the clip was being written drops it here,
    // before the mode switch below would cut that recording.
    if (shouldPlay && !shouldPlay()) {
      void FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
      return;
    }
    // The recorder leaves the session in `allowsRecording: true`; playback must
    // flip it off (iOS) or the player stays silent behind the record route.
    // #1603 — `shouldPlayInBackground`: a spoken answer finishes with the
    // screen off / app backgrounded. iOS: pairs with `UIBackgroundModes:
    // ["audio"]` (app.json) on the `.playback` session category expo-audio
    // selects when not recording. Android (expo-audio 57): the config plugin
    // declares the media-playback foreground service, and the player must be
    // activated for the lock screen below or the OS stops playback after
    // ~3 min in the background; that activation requires `doNotMix`
    // (expo-audio docs) — see docs/mobile/RELEASE-RUNBOOK.md.
    await setAudioModeAsync({
      allowsRecording: false,
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: 'doNotMix',
    });
    if (!player) {
      player = createAudioPlayer(uri);
      // One answer at a time: release the lock-screen session when the clip
      // ends so the "now playing" card does not outlive the answer.
      player.addListener('playbackStatusUpdate', (status) => {
        if (status.didJustFinish) player?.clearLockScreenControls();
      });
    } else {
      player.replace(uri);
    }
    player.setActiveForLockScreen(true, { title: 'Rivet', artist: 'Assistant answer' });
    player.play();
    if (previousUri) {
      void FileSystem.deleteAsync(previousUri, { idempotent: true }).catch(() => {});
    }
    previousUri = uri;
  },
};

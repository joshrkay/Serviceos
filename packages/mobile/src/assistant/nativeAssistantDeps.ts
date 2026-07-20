import { fetch as expoFetch } from 'expo/fetch';
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import * as FileSystem from 'expo-file-system';

// Native implementations of the assistant deps (U13). Kept out of
// useAssistantSession.ts so the hook stays testable with injected fakes;
// excluded from unit coverage like the other native*Deps modules.

/**
 * Streaming-capable fetch for the SSE reader. RN's built-in fetch cannot
 * stream response bodies; `expo/fetch` exposes WHATWG ReadableStream support.
 * If this transport misbehaves on device, the plan-B swap is
 * `react-native-sse` behind the same (url, init) => Response seam.
 */
export function streamFetch(url: string, init: RequestInit): Promise<Response> {
  return expoFetch(url, init as Parameters<typeof expoFetch>[1]) as unknown as Promise<Response>;
}

/**
 * TTS playback: base64 mp3 → cache file → expo-audio player. Greenfield —
 * the repo previously used expo-audio for recording only. The recorder side
 * (useHoldToTalkRecorder) re-asserts `allowsRecording: true` on every press,
 * so toggling it off here for playback is safe on iOS.
 */
let player: AudioPlayer | null = null;
let clipCounter = 0;

export async function playBase64Tts(b64: string): Promise<void> {
  const dir = FileSystem.cacheDirectory;
  if (!dir) return;
  // Alternate between two files so replacing the currently-playing source
  // never truncates a file the player is still reading.
  clipCounter += 1;
  const path = `${dir}assistant-tts-${clipCounter % 2}.mp3`;
  await FileSystem.writeAsStringAsync(path, b64, { encoding: FileSystem.EncodingType.Base64 });
  await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
  if (!player) {
    player = createAudioPlayer({ uri: path });
  } else {
    player.replace({ uri: path });
  }
  player.play();
}

// Resolve-time stub for expo-audio. Its package entry is react-native-only and
// doesn't resolve under the jsdom env the hook test uses; it's mocked per test
// (vi.mock), so these bodies never run. Must be a distinct module from the
// expo-file-system stub so each mock registers separately.
export const AudioModule = {
  requestRecordingPermissionsAsync: async () => ({ granted: false }),
};
export const setAudioModeAsync = async () => {};
export const RecordingPresets = { HIGH_QUALITY: {} };
export const useAudioRecorder = () => ({
  prepareToRecordAsync: async () => {},
  record: () => {},
  stop: async () => {},
  uri: null as string | null,
});

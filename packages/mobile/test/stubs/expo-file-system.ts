// Resolve-time stub for expo-file-system (see ./expo-audio.ts for why). Mocked
// per test; this body never runs. Kept a separate module so its mock does not
// collide with the expo-audio mock.
export const getInfoAsync = async () => ({ exists: false as boolean, size: 0 });

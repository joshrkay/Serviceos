// Resolve-time stub for expo-crypto (see ./expo-file-system.ts for why). The
// native module pulls in expo-modules-core, which doesn't resolve under the
// node/jsdom test env. Modules that only *reference* expo-crypto at import time
// (the offline-queue + voice native adapters) resolve against this stub; tests
// that exercise the id path inject their own makeId, so this body rarely runs.
let counter = 0;
export function randomUUID(): string {
  counter += 1;
  return `stub-uuid-${counter}`;
}

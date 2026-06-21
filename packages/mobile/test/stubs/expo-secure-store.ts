// Resolve-time stub for expo-secure-store under the jsdom/root-only test lane.
// An in-memory keychain so secure-store-backed modules import cleanly; tests
// that assert behavior mock the consuming module directly.
const store = new Map<string, string>();

export async function getItemAsync(key: string): Promise<string | null> {
  return store.has(key) ? (store.get(key) as string) : null;
}

export async function setItemAsync(key: string, value: string): Promise<void> {
  store.set(key, value);
}

export async function deleteItemAsync(key: string): Promise<void> {
  store.delete(key);
}

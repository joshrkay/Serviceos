import * as SecureStore from 'expo-secure-store';

/**
 * Clerk token cache backed by the device keychain/keystore (`expo-secure-store`).
 * This is the Clerk-documented native replacement for the browser cookie
 * storage the web app relies on. Structurally matches Clerk's `TokenCache`.
 */
export const tokenCache = {
  async getToken(key: string): Promise<string | null> {
    try {
      return await SecureStore.getItemAsync(key);
    } catch {
      return null;
    }
  },
  async saveToken(key: string, value: string): Promise<void> {
    try {
      await SecureStore.setItemAsync(key, value);
    } catch {
      // keychain unavailable — Clerk falls back to in-memory for this session
    }
  },
  async clearToken(key: string): Promise<void> {
    try {
      await SecureStore.deleteItemAsync(key);
    } catch {
      // ignore
    }
  },
};

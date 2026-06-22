// Native binding for the owner's callback number (expo-secure-store). Thin and
// device-coupled so useStartCall / settings stay testable; excluded from
// coverage (no logic to assert). Normalizes on write so only callable numbers
// are stored.
import * as SecureStore from 'expo-secure-store';
import { CALLBACK_NUMBER_KEY, normalizeCallbackNumber } from './callbackNumber';

export async function getCallbackNumber(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(CALLBACK_NUMBER_KEY);
  } catch {
    return null;
  }
}

/** Persist a normalized number; returns the stored value or null if invalid. */
export async function saveCallbackNumber(raw: string): Promise<string | null> {
  const normalized = normalizeCallbackNumber(raw);
  if (!normalized) return null;
  try {
    await SecureStore.setItemAsync(CALLBACK_NUMBER_KEY, normalized);
  } catch {
    // keychain unavailable — caller keeps the in-memory value for the session
  }
  return normalized;
}

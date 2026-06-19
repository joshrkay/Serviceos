/**
 * Biometric app-lock state machine (mobile).
 *
 * When the user enables "Require biometric unlock", the app shows a blocking
 * gate on cold start and whenever it returns from background; a successful
 * biometric check (device-passcode fallback handled by the native plugin)
 * clears it. Pure state machine with injected ports — the BiometricAuth
 * plugin call and the Preferences-backed toggle are wired in the native shell.
 * No-op on web: the gate is never engaged unless `isEnabled()` is true.
 *
 * Security: a failed/cancelled check keeps the app locked (no bypass), and the
 * gate stores no secrets — Clerk still owns the session.
 */
export type LockState = 'locked' | 'unlocked';

export interface AppLockPorts {
  /** Whether the user enabled the lock (Capacitor Preferences on native). */
  isEnabled: () => boolean;
  /** Run the biometric/passcode check; resolves true on success. */
  authenticate: () => Promise<boolean>;
}

export interface AppLock {
  getState(): LockState;
  /** Cold start: lock if enabled. Returns the resulting state. */
  start(): LockState;
  /** App resumed from background: re-lock if enabled. Returns the state. */
  onResume(): LockState;
  /** Attempt to clear the gate; resolves true when unlocked. */
  unlock(): Promise<boolean>;
  subscribe(listener: (state: LockState) => void): () => void;
}

export function createAppLock(ports: AppLockPorts): AppLock {
  let state: LockState = 'unlocked';
  let unlocking = false;
  const listeners = new Set<(state: LockState) => void>();

  const set = (next: LockState) => {
    if (next === state) return;
    state = next;
    for (const l of listeners) l(state);
  };

  return {
    getState: () => state,

    start(): LockState {
      set(ports.isEnabled() ? 'locked' : 'unlocked');
      return state;
    },

    onResume(): LockState {
      if (ports.isEnabled()) set('locked');
      return state;
    },

    async unlock(): Promise<boolean> {
      if (state === 'unlocked') return true;
      if (unlocking) return false; // a check is already in flight
      unlocking = true;
      try {
        const ok = await ports.authenticate();
        if (ok) set('unlocked');
        return ok;
      } catch {
        // A failed/errored check must NOT unlock.
        return false;
      } finally {
        unlocking = false;
      }
    },

    subscribe(listener: (state: LockState) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

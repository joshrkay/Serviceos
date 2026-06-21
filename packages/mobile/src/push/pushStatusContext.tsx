/**
 * Shares the push-registration outcome with the screens that nudge about it.
 *
 * `usePushRegistration` runs once at the root (the auth gate) — calling it again
 * on a screen would kick off a second registration attempt and prompt again.
 * Instead the gate publishes its result here, and Settings/Home read it via
 * `usePushStatus()` to show the "notifications are off" nudge when permission was
 * denied. The provider holds only a value, so it never re-registers.
 */
import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import type { PushStatus } from '../hooks/usePushRegistration';

const PushStatusContext = createContext<PushStatus>(null);

export function PushStatusProvider({
  status,
  children,
}: {
  status: PushStatus;
  children: ReactNode;
}) {
  return <PushStatusContext.Provider value={status}>{children}</PushStatusContext.Provider>;
}

/** The last push-registration outcome (null until it resolves / when signed out). */
export function usePushStatus(): PushStatus {
  return useContext(PushStatusContext);
}

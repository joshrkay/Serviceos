/**
 * Nurture engine hook (INTERFACE + registration point).
 *
 * The lifecycle event bus (src/lib/lifecycle.ts) calls notifyNurture() on
 * every lifecycle event. This module owns the swappable-engine interface
 * (NurtureEngine / setNurtureEngine) so lifecycle.ts and its tests never need
 * to know which engine is active.
 *
 * The real engine (src/lib/nurture/engine.ts — LiveNurtureEngine, backed by
 * the 8 written sequences, the test-contacts-only allowlist gate, and the
 * Resend/preview transports) is registered as the active engine at the
 * bottom of this file, at module load. Tests can still call setNurtureEngine()
 * to swap in a mock/spy, exactly as before.
 */

import type { LifecycleEvent } from '../lifecycle';
import { liveNurtureEngine } from './engine';

export interface NurtureNotification {
  /** Which lifecycle moment fired. */
  type: LifecycleEvent['type'];
  /** Contact email if known (drives sequence enrollment). */
  email?: string;
  /** Business context for personalization. */
  businessName?: string;
  vertical?: string;
  plan?: string;
  /** Free-form structured payload for the worker. */
  data: Record<string, unknown>;
}

export interface NurtureEngine {
  notify(notification: NurtureNotification): Promise<void> | void;
}

/**
 * Default stub engine. Replaced/augmented by the nurture worker. Logs a
 * structured line so the hand-off point is observable in preview logs.
 */
export const stubNurtureEngine: NurtureEngine = {
  notify(notification) {
    console.log(
      JSON.stringify({
        at: new Date().toISOString(),
        source: 'nurture.stub',
        ...notification,
      }),
    );
  },
};

let activeEngine: NurtureEngine = stubNurtureEngine;

/** Allows the nurture worker (or tests) to swap in a real engine. */
export function setNurtureEngine(engine: NurtureEngine): void {
  activeEngine = engine;
}

/** Entry point invoked by the lifecycle bus for every event. */
export async function notifyNurture(event: LifecycleEvent): Promise<void> {
  await activeEngine.notify({
    type: event.type,
    email: event.email,
    businessName: event.businessName,
    vertical: event.vertical,
    plan: event.plan,
    data: event.data ?? {},
  });
}

/**
 * Wire the real nurture engine in as the default active engine. This is the
 * "prefer registering your engine without editing lifecycle.ts" approach:
 * lifecycle.ts is untouched, and the moment this module is imported (which it
 * always is, since lifecycle.ts imports notifyNurture from here), the live
 * engine takes over from the logging stub. Tests that need a mock still call
 * setNurtureEngine()/restore stubNurtureEngine in beforeEach/afterEach, which
 * simply overrides this default for their duration.
 */
setNurtureEngine(liveNurtureEngine);

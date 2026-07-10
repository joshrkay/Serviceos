/**
 * Nurture engine hook (INTERFACE + STUB).
 *
 * The lifecycle event bus calls notifyNurture() on every lifecycle event. The
 * dedicated nurture worker fleshes out the real implementation (email/SMS
 * sequences via RESEND_API_KEY etc.). For now this stub only logs so the wiring
 * is provable end-to-end.
 */

import type { LifecycleEvent } from '../lifecycle';

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

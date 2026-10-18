/**
 * The voice check's blockers (onboarding/derive-status.ts) in the owner's
 * words. The check itself has no screen; to the owner it is Rivet getting its
 * voice ready before the test call.
 */
const BLOCKER_COPY: Record<string, string> = {
  ai_config_missing: "I'm not ready to answer calls yet, which usually clears up on its own; if it doesn't, contact support.",
  ai_verification_failed: "I didn't sound right on my last check. Try again and I'll go over it once more.",
};

export function voiceBlockerCopy(blockers: string[] | undefined): string {
  return BLOCKER_COPY[blockers?.[0] ?? 'ai_verification_failed'] ?? "I couldn't get my voice ready. Try again.";
}

/** Why the retry or the skip did not go through. */
export function voiceActionErrorCopy(status: number): string {
  return status >= 500 ? "That didn't go through. Wait a minute and try again." : "That didn't go through. Try again.";
}

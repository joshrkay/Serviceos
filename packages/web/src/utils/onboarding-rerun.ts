/**
 * #875 — "Re-run setup assistant" deep-links to /onboarding with this
 * query param. OnboardingShell reads it to pre-seed its step override past
 * the completion bounce; the Settings and Templates entry points build
 * their links from the same definition so the two halves can't drift.
 */
export const RERUN_PARAM = 'rerun';

const RERUN_VALUE = '1';

/** The canonical explicit re-run deep link. */
export const ONBOARDING_RERUN_PATH = `/onboarding?${RERUN_PARAM}=${RERUN_VALUE}`;

/** True when the current URL marks an explicit onboarding re-run. */
export function isExplicitRerun(params: URLSearchParams): boolean {
  return params.get(RERUN_PARAM) === RERUN_VALUE;
}

import { getLocalFlag } from './uiFlags';
import { getRuntimeConfigValue } from './runtimeConfig';

/** localStorage key for the per-browser override: `localStorage.setItem('onboarding_v3', '1')`. */
export const ONBOARDING_V3_FLAG = 'onboarding_v3';

const ON = new Set(['1', 'true', 'on', 'yes']);
const OFF = new Set(['0', 'false', 'off', 'no']);

/**
 * Whether /onboarding renders the "pick, don't build" conversation shell (v3)
 * instead of the v2 sidebar shell.
 *
 * The per-browser flag wins in either direction (a tester can opt in, or opt
 * out of a deployed default). Without it, the `VITE_ONBOARDING_V3` default
 * decides, read through the runtime config like the other VITE_ONBOARDING_*
 * switches. Off when neither is set.
 */
export function isOnboardingV3Enabled(): boolean {
  const local = getLocalFlag(ONBOARDING_V3_FLAG)?.trim().toLowerCase();
  if (local !== undefined) {
    if (OFF.has(local)) return false;
    if (ON.has(local)) return true;
  }
  const fromEnv = getRuntimeConfigValue('VITE_ONBOARDING_V3')?.toLowerCase();
  return fromEnv !== undefined && ON.has(fromEnv);
}

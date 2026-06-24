/**
 * Story 2.5 — tenant terminology, rendered everywhere.
 *
 * Single hook the whole app uses to render a canonical CRM entity in the
 * tenant's own words. "Estimate" becomes "Quote", "Job" becomes
 * "Project", "Appointment" becomes "Visit" — whatever the owner captured
 * during onboarding or in the Terminology settings sheet.
 *
 * Backed by `useMe()` (module-cached `/api/me`), so adopting it in a new
 * surface costs no extra network round-trip. Falls back to the platform
 * defaults from the shared resolver whenever a preference is unset or the
 * bootstrap call hasn't landed yet — wrong-but-readable beats a flash of
 * empty labels.
 */
import { useMemo } from 'react';
import {
  resolveEntityLabel,
  resolveEntityLabels,
  type EntityTermKey,
} from '@ai-service-os/shared';
import { useMe } from './useMe';

export interface EntityLabels {
  /** Resolved singular label for every canonical entity. */
  labels: Record<EntityTermKey, string>;
  /**
   * Resolve a single entity to the tenant's label.
   * `label('estimateTerm')` → "Quote"; `label('estimateTerm', { plural: true })` → "Quotes".
   */
  label: (key: EntityTermKey, opts?: { plural?: boolean }) => string;
}

export function useEntityLabels(): EntityLabels {
  const { me } = useMe();
  const prefs = me?.terminology_preferences;

  return useMemo<EntityLabels>(
    () => ({
      labels: resolveEntityLabels(prefs),
      label: (key, opts) => resolveEntityLabel(prefs, key, opts),
    }),
    [prefs],
  );
}

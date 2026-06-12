/**
 * Rivet P2 F-1 — payload `_meta` helpers for supervisor markers and the
 * advisory annotation.
 *
 * Schema constraints honored here (contracts.ts validates `_meta` at
 * every edit via the confidence-meta envelope, so a sloppy write would
 * make the proposal uneditable):
 *   - `_meta.overallConfidence` is REQUIRED whenever `_meta` exists. When
 *     the payload had no prior `_meta` and we are synthesizing the field
 *     for the first time, we ALWAYS use the fixed value 'medium' —
 *     never score-derived, never 'high'/'low'/'very_low'. Score-derived
 *     synthesis would produce invented badges ('high confidence!') that
 *     the advisory layer is not authorised to assert; 'medium' is a neutral
 *     placeholder. Existing (real) `_meta.overallConfidence` values are
 *     preserved unchanged.
 *   - `markers[].path` must be non-empty (z.string().min(1)), so the
 *     supervisor marker uses the synthetic path '_supervisor' rather
 *     than '' (the marker refers to the proposal as a whole, not a
 *     payload field).
 *   - `_meta.supervisorAnnotation` is an unknown key to the strip-mode
 *     envelope — it passes validation untouched.
 *
 * All helpers are non-mutating: they shallow-clone payload and `_meta`.
 */

/** Synthetic marker path — the supervisor verdict concerns the whole proposal. */
export const SUPERVISOR_MARKER_PATH = '_supervisor';

export interface SupervisorAnnotation {
  riskSummary: string;
  flags: string[];
  annotatedAt: string;
}

const CONFIDENCE_LEVEL_VALUES = new Set(['high', 'medium', 'low', 'very_low']);

function cloneWithValidMeta(
  payload: Record<string, unknown>,
): { next: Record<string, unknown>; meta: Record<string, unknown> } {
  const existing = payload._meta;
  const meta: Record<string, unknown> =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  if (
    typeof meta.overallConfidence !== 'string' ||
    !CONFIDENCE_LEVEL_VALUES.has(meta.overallConfidence)
  ) {
    // Architect ruling (Rivet P2 review): always synthesize 'medium' — never
    // derive from the numeric score. Score-derived synthesis emits invented
    // confidence badges ('high') that the advisory layer cannot assert.
    // Existing real _meta.overallConfidence values pass through untouched.
    meta.overallConfidence = 'medium';
  }
  const next = { ...payload, _meta: meta };
  return { next, meta };
}

/**
 * Append a supervisor marker explaining a block / force_review verdict.
 * Existing markers (and the rest of `_meta`) are preserved.
 *
 * The `confidenceScore` parameter is accepted but intentionally ignored —
 * see module header for why synthesis is always fixed 'medium'.
 */
export function payloadWithSupervisorMarker(
  payload: Record<string, unknown>,
  reasons: string[],
  _confidenceScore?: number,
): Record<string, unknown> {
  const { next, meta } = cloneWithValidMeta(payload);
  const markers = Array.isArray(meta.markers) ? [...(meta.markers as unknown[])] : [];
  markers.push({ path: SUPERVISOR_MARKER_PATH, reason: `supervisor: ${reasons.join('; ')}` });
  meta.markers = markers;
  return next;
}

/**
 * Write the advisory annotation (annotator worker). Never a status change.
 *
 * The `confidenceScore` parameter is accepted but intentionally ignored —
 * see module header for why synthesis is always fixed 'medium'.
 */
export function payloadWithSupervisorAnnotation(
  payload: Record<string, unknown>,
  annotation: SupervisorAnnotation,
  _confidenceScore?: number,
): Record<string, unknown> {
  const { next, meta } = cloneWithValidMeta(payload);
  meta.supervisorAnnotation = annotation;
  return next;
}

/** True when the annotator already visited this payload. */
export function hasSupervisorAnnotation(payload: Record<string, unknown>): boolean {
  const meta = payload._meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
  const annotation = (meta as Record<string, unknown>).supervisorAnnotation;
  return annotation !== undefined && annotation !== null;
}

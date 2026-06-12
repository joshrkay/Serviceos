/**
 * Rivet P2 F-1 — payload `_meta` helpers for supervisor markers and the
 * advisory annotation.
 *
 * Schema constraints honored here (contracts.ts validates `_meta` at
 * every edit via the confidence-meta envelope, so a sloppy write would
 * make the proposal uneditable):
 *   - `_meta.overallConfidence` is REQUIRED whenever `_meta` exists. If
 *     the payload had no `_meta`, we synthesize the level from the
 *     proposal's numeric confidence score via the canonical
 *     `getConfidenceLevel` mapping ('medium' when no score) — display
 *     metadata only; it can never UPGRADE anything (only 'low'/'very_low'
 *     have behavioral meaning and they block auto-approval).
 *   - `markers[].path` must be non-empty (z.string().min(1)), so the
 *     supervisor marker uses the synthetic path '_supervisor' rather
 *     than '' (the marker refers to the proposal as a whole, not a
 *     payload field).
 *   - `_meta.supervisorAnnotation` is an unknown key to the strip-mode
 *     envelope — it passes validation untouched.
 *
 * All helpers are non-mutating: they shallow-clone payload and `_meta`.
 */
import { getConfidenceLevel } from '../../ai/guardrails/confidence';

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
  confidenceScore: number | undefined,
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
    meta.overallConfidence =
      confidenceScore !== undefined ? getConfidenceLevel(confidenceScore) : 'medium';
  }
  const next = { ...payload, _meta: meta };
  return { next, meta };
}

/**
 * Append a supervisor marker explaining a block / force_review verdict.
 * Existing markers (and the rest of `_meta`) are preserved.
 */
export function payloadWithSupervisorMarker(
  payload: Record<string, unknown>,
  reasons: string[],
  confidenceScore?: number,
): Record<string, unknown> {
  const { next, meta } = cloneWithValidMeta(payload, confidenceScore);
  const markers = Array.isArray(meta.markers) ? [...(meta.markers as unknown[])] : [];
  markers.push({ path: SUPERVISOR_MARKER_PATH, reason: `supervisor: ${reasons.join('; ')}` });
  meta.markers = markers;
  return next;
}

/** Write the advisory annotation (annotator worker). Never a status change. */
export function payloadWithSupervisorAnnotation(
  payload: Record<string, unknown>,
  annotation: SupervisorAnnotation,
  confidenceScore?: number,
): Record<string, unknown> {
  const { next, meta } = cloneWithValidMeta(payload, confidenceScore);
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

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
 */
export function payloadWithSupervisorMarker(
  payload: Record<string, unknown>,
  reasons: string[],
): Record<string, unknown> {
  const { next, meta } = cloneWithValidMeta(payload);
  const markers = Array.isArray(meta.markers) ? [...(meta.markers as unknown[])] : [];
  markers.push({ path: SUPERVISOR_MARKER_PATH, reason: `supervisor: ${reasons.join('; ')}` });
  meta.markers = markers;
  return next;
}

/**
 * Write the advisory annotation (annotator worker). Never a status change.
 */
export function payloadWithSupervisorAnnotation(
  payload: Record<string, unknown>,
  annotation: SupervisorAnnotation,
): Record<string, unknown> {
  const { next, meta } = cloneWithValidMeta(payload);
  meta.supervisorAnnotation = annotation;
  return next;
}

/**
 * How many failed annotation attempts a proposal gets before later sweeps stop
 * retrying it. The annotator runs every 60s over a 24h window, so without a
 * budget a permanently-failing proposal costs ~1,440 gateway calls/day on its
 * own. Three attempts absorbs a transient provider blip while capping a
 * deterministic failure (a bad prompt, an unparseable model, a poison payload)
 * at three calls total instead of a day's worth.
 */
export const MAX_ANNOTATION_ATTEMPTS = 3;

/** `_meta` key holding the annotator's failure bookkeeping. */
export const ANNOTATION_ATTEMPTS_KEY = 'supervisorAnnotationAttempts';

export interface SupervisorAnnotationAttempts {
  count: number;
  lastAttemptAt: string;
}

function readAttempts(payload: Record<string, unknown>): SupervisorAnnotationAttempts | null {
  const meta = payload._meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const raw = (meta as Record<string, unknown>)[ANNOTATION_ATTEMPTS_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const count = (raw as Record<string, unknown>).count;
  const lastAttemptAt = (raw as Record<string, unknown>).lastAttemptAt;
  // Defensive: a hand-edited or truncated marker must read as "no attempts"
  // rather than throwing or silently disabling annotation forever.
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return null;
  return {
    count: Math.floor(count),
    lastAttemptAt: typeof lastAttemptAt === 'string' ? lastAttemptAt : '',
  };
}

/** Failed annotation attempts recorded so far (0 when never attempted). */
export function annotationAttemptCount(payload: Record<string, unknown>): number {
  return readAttempts(payload)?.count ?? 0;
}

/**
 * True when this proposal has burned its annotation attempt budget and later
 * sweeps should leave it alone. Advisory-only: the proposal is still fully
 * reviewable by the human, it just never gets the optional AI note.
 */
export function hasExhaustedAnnotationAttempts(payload: Record<string, unknown>): boolean {
  return annotationAttemptCount(payload) >= MAX_ANNOTATION_ATTEMPTS;
}

/**
 * Increment the failed-attempt counter. Non-mutating, and touches nothing in
 * `_meta` besides this one key — the annotator's whole contract is that it only
 * ever writes `payload._meta`, never the proposal status.
 */
export function payloadWithAnnotationAttempt(
  payload: Record<string, unknown>,
  attemptedAt: string,
): Record<string, unknown> {
  const { next, meta } = cloneWithValidMeta(payload);
  meta[ANNOTATION_ATTEMPTS_KEY] = {
    count: annotationAttemptCount(payload) + 1,
    lastAttemptAt: attemptedAt,
  } satisfies SupervisorAnnotationAttempts;
  return next;
}

/** True when the annotator already visited this payload. */
export function hasSupervisorAnnotation(payload: Record<string, unknown>): boolean {
  const meta = payload._meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
  const annotation = (meta as Record<string, unknown>).supervisorAnnotation;
  return annotation !== undefined && annotation !== null;
}

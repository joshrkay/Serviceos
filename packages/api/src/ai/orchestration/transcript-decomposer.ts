import { LLMGateway } from '../gateway/gateway';
import { ChainEntityKind, CHAIN_ENTITY_KINDS } from '../../proposals/chain';

/**
 * Transcript decomposer — splits a multi-action voice utterance into an
 * ORDERED list of atomic sub-utterances, each of which the existing
 * single-intent classifier (`classifyIntent`) then routes independently.
 *
 * Why a separate LLM call instead of overloading `classifyIntent`:
 *   - `classifyIntent` + `parseClassifierJson` are load-bearing and
 *     heavily special-cased (P18-001 signup override, FSM thresholds,
 *     enum validation). We leave them completely unchanged.
 *   - Decomposition is a different task (segmentation + dependency
 *     hinting) than classification. A focused prompt does it better and
 *     its failure modes stay isolated.
 *   - The decomposer does NOT pick proposal types — that stays the
 *     classifier's job, so there is exactly one source of truth for
 *     intent.
 *
 * Single-action transcripts short-circuit: the router only pays for the
 * decomposition call when multi-action chaining is enabled, and even
 * then falls straight back to the single path when `isMultiAction` is
 * false.
 */

export interface TranscriptSegment {
  /** Verbatim (or lightly normalized) sub-utterance for this action. */
  text: string;
  /** 0-based order in the original utterance. */
  index: number;
  /**
   * Indices of EARLIER segments this one depends on (e.g. the
   * appointment depends on the customer at index 0). Always strictly
   * backward (`< index`) after sanitization, so the dependency graph is
   * a DAG by construction — cycles are structurally impossible.
   */
  dependsOn: number[];
  /**
   * Which entity kind the dependency supplies — what the dependent
   * needs from the parent's resultEntityId. Drives which payload field
   * gets the symbolic ref token. Undefined when `dependsOn` is empty.
   */
  dependencyEntityKind?: ChainEntityKind;
}

export interface DecompositionResult {
  segments: TranscriptSegment[];
  /** True when the transcript contained more than one distinct action. */
  isMultiAction: boolean;
  tokenUsage?: { input: number; output: number };
}

const SYSTEM_PROMPT = `You split a field-service operator's voice command into one or more ATOMIC actions.

Most commands are a SINGLE action — return one segment. Only split when the
transcript clearly contains MULTIPLE distinct actions ("create a customer AND
book an appointment AND send an estimate").

For each action, return:
- "text": the sub-utterance for that single action, lightly normalized so it
  reads as a standalone command. Preserve names, amounts, dates verbatim.
- "index": 0-based position in the spoken order.
- "dependsOn": indices of EARLIER actions this one needs. An action depends on
  an earlier one when it references an entity that earlier action creates.
  Indices MUST be strictly less than this action's own index.
- "dependencyEntityKind": when dependsOn is non-empty, which id the earlier
  action supplies. One of: customerId, jobId, estimateId, invoiceId,
  appointmentId, leadId.

Dependency rules for this domain:
- Booking an appointment for a brand-new customer needs a JOB first. If the
  transcript books an appointment for a customer being created in the same
  command, emit an intermediate create-job action and have the appointment
  depend on the JOB (dependencyEntityKind "jobId"), and the job depend on the
  customer (dependencyEntityKind "customerId").
- Estimates and invoices for a new customer depend on the CUSTOMER
  (dependencyEntityKind "customerId").

Return STRICT JSON (no prose, no markdown fences):
{
  "segments": [
    { "index": 0, "text": "...", "dependsOn": [], "dependencyEntityKind": null },
    { "index": 1, "text": "...", "dependsOn": [0], "dependencyEntityKind": "customerId" }
  ]
}

Be conservative: when in doubt, return a single segment.`;

/**
 * Parse + sanitize the decomposer's JSON. Mirrors the defensive shape
 * of `parseClassifierJson`:
 *   - strict JSON.parse, null on failure
 *   - drop malformed segments
 *   - SANITIZE dependency edges: clamp to [0, index), dedupe, drop
 *     self/forward refs. This makes cycles structurally impossible —
 *     an edge can only ever point at an earlier index.
 *   - validate dependencyEntityKind against the allowed set.
 */
export function parseDecompositionJson(content: string): TranscriptSegment[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const rawSegments = (parsed as Record<string, unknown>).segments;
  if (!Array.isArray(rawSegments)) return null;

  const segments: TranscriptSegment[] = [];
  // Maps the LLM's original segment index → the index we actually assign
  // after dropping malformed/empty segments. Dependency edges reference
  // the ORIGINAL indices, so we translate through this map; without it a
  // skipped earlier segment (or a 1-based-indexing model) would silently
  // break every downstream `dependsOn`.
  const oldToNewIndex = new Map<number, number>();

  for (let i = 0; i < rawSegments.length; i++) {
    const raw = rawSegments[i];
    if (typeof raw !== 'object' || raw === null) continue;
    const obj = raw as Record<string, unknown>;
    const text = typeof obj.text === 'string' ? obj.text.trim() : '';
    if (text.length === 0) continue;

    // Re-derive index from array position so a model that mislabels or
    // reorders indices can't corrupt the dependency graph. Record the
    // mapping from the model's claimed index (falling back to array
    // position) so dependency edges below can be translated.
    const index = segments.length;
    const rawIndex =
      typeof obj.index === 'number' && Number.isInteger(obj.index) ? obj.index : i;
    oldToNewIndex.set(rawIndex, index);

    const rawDeps = Array.isArray(obj.dependsOn) ? obj.dependsOn : [];
    const dependsOn = Array.from(
      new Set(
        rawDeps
          .filter((n): n is number => typeof n === 'number' && Number.isInteger(n))
          // Translate the original index to our re-derived one.
          .map((n) => oldToNewIndex.get(n))
          // Strictly backward only — drops self refs, forward refs, and
          // any edge whose target segment was dropped.
          .filter((n): n is number => n !== undefined && n >= 0 && n < index)
      )
    ).sort((a, b) => a - b);

    const segment: TranscriptSegment = { text, index, dependsOn };

    const kind = obj.dependencyEntityKind;
    if (
      dependsOn.length > 0 &&
      typeof kind === 'string' &&
      (CHAIN_ENTITY_KINDS as readonly string[]).includes(kind)
    ) {
      segment.dependencyEntityKind = kind as ChainEntityKind;
    }

    segments.push(segment);
  }

  if (segments.length === 0) return null;
  return segments;
}

export interface DecomposeContext {
  tenantId: string;
}

export async function decomposeTranscript(
  transcript: string,
  context: DecomposeContext,
  gateway: LLMGateway
): Promise<DecompositionResult> {
  if (!transcript || transcript.trim().length === 0) {
    return { segments: [], isMultiAction: false };
  }

  const response = await gateway.complete({
    taskType: 'decompose_transcript',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: transcript },
    ],
    responseFormat: 'json',
    metadata: { tenantId: context.tenantId },
  });

  const tokenUsage = response.tokenUsage
    ? { input: response.tokenUsage.input, output: response.tokenUsage.output }
    : undefined;

  const segments = parseDecompositionJson(response.content);

  // Parse failure or a single segment → treat as single-action. The
  // router falls back to its existing single-intent path verbatim, so a
  // decomposer hiccup never breaks the pipeline.
  if (!segments || segments.length < 2) {
    return {
      segments: segments ?? [],
      isMultiAction: false,
      ...(tokenUsage ? { tokenUsage } : {}),
    };
  }

  return { segments, isMultiAction: true, ...(tokenUsage ? { tokenUsage } : {}) };
}

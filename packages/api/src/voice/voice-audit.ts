/**
 * Deterministic idempotency keys derived from a voice recording id, so an
 * at-least-once redelivery of the same recording dedups what it writes.
 *
 * OBS-2 — this module used to also hold a `VoiceAuditRepository` (transcription
 * attempts, transcript versions, intent runs with a per-turn `aiRunId`,
 * command runs, feedback labels, a tenant lexicon) with only an in-memory
 * implementation: no table, no Pg repository, no caller. Its `createIntentRun`
 * was the designed per-turn link between a voice turn and its AI run, and
 * nothing ever called it. Deleted under the dead-code rule; the link it was
 * meant to provide now lives on the proposal itself (`proposals.ai_run_id` =
 * the drafting run, `sourceContext.classifierAiRunId` = the routing run, and
 * `ai_runs.correlation_id` = the conversation — ai/tasks/task-handlers.ts
 * `draftingRunMetadata`). Recoverable from git history if a voice audit trail
 * is ever built for real.
 */

/**
 * Idempotency key for the PROPOSAL a voice recording produces. Its own
 * `voice-proposal:` prefix, so it never collides with the hold key below
 * even though both are derived from the same recordingId.
 */
export function voiceProposalIdempotencyKey(recordingId: string): string {
  return `voice-proposal:${recordingId}`;
}

/**
 * Idempotency key for the tentative APPOINTMENT HOLD a voice booking places.
 * Distinct prefix again so a redelivered recording dedups the hold and the
 * proposal independently without their keys colliding.
 */
export function voiceHoldIdempotencyKey(recordingId: string): string {
  return `voice-hold:${recordingId}`;
}

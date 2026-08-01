/**
 * RIVET invariant I13 — content-provenance classification (the "decide" half;
 * `untrusted-content.ts` is the matching "render" half).
 *
 * One canonical answer to "is this stored text caller-authored (untrusted)?",
 * replacing ad-hoc `senderRole === 'customer'` checks scattered across call
 * sites. Provenance travels with the CONTENT, not the session: the row markers
 * consulted here (`messages.senderRole`, `call_transcript_turns.speaker`,
 * `voice_recordings.source` + `transcript_metadata.provenance`) are written at
 * ingest and live with the row, so a read three hours later still knows a
 * stranger authored the words.
 *
 * Untrusted content may be stored, displayed, and summarized — but it may
 * never enter an S2 (operator) agent context as instruction-eligible text.
 * Render it through `buildUntrustedContentSection` (untrusted-content.ts).
 *
 * Dependency-light by design: plain types only — no repos, no gateway — so
 * storage-layer modules never need to import AI-layer machinery to use it.
 */

export type ContentProvenance = 'trusted' | 'untrusted';

/**
 * Provenance of the speakers on a voice recording's transcript, carried in
 * `voice_recordings.transcript_metadata.provenance` (JSONB — no migration;
 * stamped by the transcript-ingestion worker from the real per-turn speaker
 * distribution).
 */
export type RecordingProvenance = 'caller' | 'mixed' | 'operator';

/**
 * A conversation message row (`messages` table). `senderRole: 'customer'` is
 * the row-level marker stamped at ingest (sms/inbound-capture.ts) — the
 * canonical "a customer wrote this" signal. Every other role (user, assistant,
 * system, owner) is tenant- or system-authored.
 */
export function classifyMessageProvenance(row: { senderRole: string }): ContentProvenance {
  return row.senderRole.trim().toLowerCase() === 'customer' ? 'untrusted' : 'trusted';
}

/**
 * A per-turn call transcript row (`call_transcript_turns.speaker`).
 * `'caller'` turns are verbatim words from an unauthenticated phone caller.
 */
export function classifyTranscriptTurnProvenance(row: {
  speaker: 'agent' | 'caller';
}): ContentProvenance {
  return row.speaker === 'caller' ? 'untrusted' : 'trusted';
}

/**
 * A whole voice recording. Two markers compose, and the result FAILS CLOSED:
 *
 *  - `source = 'inbound_call'` → untrusted regardless of metadata: caller
 *    audio is on the recording, so its transcript contains caller words.
 *  - `source = 'inapp_voice'` (authenticated operator memo) → trusted only
 *    when the stamped metadata provenance confirms `'operator'`; a missing
 *    stamp means the per-turn distribution was never verified.
 *  - `'batch_upload'`, unknown sources, and missing/unknown metadata all
 *    classify as untrusted. Legacy rows and forgetful writers are the common
 *    case for this store — unmarked content must never default to trusted.
 */
export function classifyRecordingProvenance(recording: {
  source?: string | null;
  transcriptMetadata?: Record<string, unknown> | null;
}): ContentProvenance {
  if (recording.source === 'inbound_call') return 'untrusted';
  const stamped = recording.transcriptMetadata?.provenance;
  if (recording.source === 'inapp_voice' && stamped === 'operator') return 'trusted';
  return 'untrusted';
}

# feat: I13 untrusted-content provenance — completion (classifier, SourceContext fence seam, recording provenance)

**Created:** 2026-07-24
**Depth:** Standard
**Status:** plan

## Summary

Completes RIVET invariant I13. The fence half already shipped
(`packages/api/src/ai/untrusted-content.ts`, applied at suggest-reply and
summarize-session). This plan adds the **classifier half** — a single
canonical "is this content untrusted?" module — plus the two remaining
surfaces: a reusable fenced-prompt seam for `SourceContext.recentMessages`
consumers, and an explicit provenance marker on `voice_recordings`
transcripts (the one store with no row-level speaker marker at all).

## Problem Frame

Caller-authored text (inbound SMS, call transcripts, voicemail) is stored
in three places. Two carry a reliable per-row marker (`messages.senderRole`,
`call_transcript_turns.speaker`); `voice_recordings.transcript` is a mixed
blob with **no marker**. Nothing centralizes the "untrusted?" decision —
`suggest-reply-task.ts` has a local `isCustomer()`, `conversation-service.ts`
has `messageDirection()`, and future `SourceContext` consumers would
hand-roll prompt assembly and forget the fence (the exact failure mode I13
exists to prevent). Decision made with the user: **hybrid** persistence —
existing row markers ARE the provenance; add an explicit marker only where
none exists. No migration on the high-volume `messages` table.

## Requirements

- R1. One canonical classifier decides trusted/untrusted for a message row,
  a transcript turn, and a recording's metadata — replacing ad-hoc
  `senderRole === 'customer'` checks.
- R2. `voice_recordings` rows carry an explicit `provenance`
  (`caller | mixed | operator`) in `transcript_metadata`, stamped by the
  live transcript-ingestion worker; **absent marker classifies as
  untrusted (fail closed)** — legacy rows must never default to trusted.
- R3. A reusable helper turns `SourceContext.conversation.recentMessages`
  into prompt sections with customer-authored lines fenced via
  `buildUntrustedContentSection`, so every future consumer gets the fence
  for free instead of hand-rolling it.
- R4. `resolveQueryText` (RAG retrieval query built from the latest
  customer message) is explicitly **not fenced** — embedding-only, never
  instruction-eligible — but gets a length cap and an I13 comment so nobody
  "fixes" or reuses it unsafely later.
- R5. Zero behavior change to the live customer-calling FSM prompt path and
  zero prompt-shape regressions in existing suites (suggest-reply fence
  bytes, context-builder structured-field tests, voice-quality cassettes).

## Key Technical Decisions

- **Classifier lives in a new `packages/api/src/ai/content-provenance.ts`**,
  sibling to `untrusted-content.ts` (fence = render half, classifier =
  decide half). Small named functions per row-kind
  (`classifyMessageProvenance`, `classifyTranscriptTurnProvenance`,
  `classifyRecordingProvenance`) rather than one polymorphic function — each
  call site self-documents, no duck-typing ambiguity. Dependency-light: no
  `pg`, no gateway imports. (Alternative considered: computed getters on the
  repository types — rejected because it pulls AI-layer concepts into
  `conversations/`/`voice/`, which are load-bearing without the AI path.)
- **`classifyRecordingProvenance` fails closed**: `undefined`/missing
  `provenance` → `untrusted`. Legacy rows and forgetful writers are the
  common case for this store, and I13 forbids unmarked S1-origin content
  silently defaulting to trusted.
- **Fence at a helper seam, NOT inside `buildSourceContext`.**
  `SourceContext.conversation.recentMessages` is structured data consumed by
  non-prompt code; three test suites assert `content` equals raw message
  text verbatim. Embedding fence markers there corrupts a data structure.
  Instead export `buildRecentMessagesPromptSections(...)` (in
  `context-builder.ts`, since it is specific to `SourceContext`'s shape)
  that partitions by `classifyMessageProvenance` and renders untrusted lines
  through `buildUntrustedContentSection` as one ready-to-inject block. Note:
  `buildSourceContext` currently has **no production caller** — this unit
  establishes the correct pattern before the first real consumer lands.
- **`resolveQueryText` stays unfenced** — its output reaches only
  `EmbeddingProvider.createEmbedding()`, never a chat-completion slot, so it
  has no instruction-eligible exposure; fencing would let the ~400-char
  hardening sentence dominate a short query's embedding and silently degrade
  retrieval tenant-wide. Mitigation instead: `MAX_QUERY_CHARS` truncation
  (cost/latency bound, not an injection control) + explicit I13 comments on
  `resolveQueryText` and the `RetrieveAdapter` query param.
- **Stamp recording provenance in `transcript-ingestion-worker.ts`, not
  `transcription.ts`.** The ingestion worker (live, registered in `app.ts`
  when an embedding provider is configured) already parses per-turn
  `{speaker, text}` and stamps sibling columns via `stampOutcome` /
  `stampDetectedLanguage`; compute `caller | mixed | operator` from the real
  speaker distribution there rather than guessing from a raw joined string
  at transcription time.
- **JSONB merge, not replace**, for the new
  `VoiceRepository.stampProvenance?()`:
  `transcript_metadata = transcript_metadata || jsonb_build_object(...)`.
  `transcription.ts` writes a rich `transcriptMetadata` object at completion
  and the ingestion worker runs after it — a full-replace (the
  `updateStatus` COALESCE pattern) would clobber it. Optional method keeps
  both existing implementers non-breaking.

## Scope Boundaries

**In scope:** the classifier module; suggest-reply refactor onto it; the
`SourceContext` prompt-section helper; `resolveQueryText` cap + comments;
`stampProvenance` repo method (pg + in-memory) and worker stamping; doc
cross-references.

**Non-goals:** fencing the live customer-calling FSM prompt path (the agent
is talking TO the caller — different trust geometry, and the voice-quality
cassette suites pin those prompt bytes); a `take_message` proposal type
(op #59 feature work); any migration on `messages` or
`call_transcript_turns` (their row markers are the provenance, per the
hybrid decision); changing `summarize-session.ts` (it already fences the
whole transcript unconditionally — conservative-correct).

### Deferred to follow-up work
- `knowledge_chunks` rows (`sourceType: 'call_summary' | 'transcript_window'`)
  are built from caller transcripts, PII-scrubbed but never fenced; nothing
  consumes `retrievedChunks` into a live prompt yet. Ticket this so the
  first RAG-consuming prompt goes through a fence-aware helper.
- Consider a `retrieval_eval_runs`-based regression check that would catch
  accidental fencing of embedding queries.
- `customers/timeline.ts` `inferDirection()` duplicates
  `conversation-service.ts` `messageDirection()` — a candidate for the same
  classifier consolidation, but it drives UI direction labels (not prompts),
  so it is not I13 work; consolidate opportunistically.
- Voicemail path hardening: voicemail today never produces a
  `voice_recordings` row or transcript (`telephony/voicemail-status-route.ts`
  creates a lead only). If/when voicemail transcription ships (op #59
  take_message), its transcript store must be born with `provenance:
  'caller'` — note this in that feature's plan.

## Repository invariants touched

- **Tenant/RLS:** no new tables or queries outside existing tenant-scoped
  repos; `stampProvenance` follows the existing `withTenant` repo pattern.
- **LLM gateway:** no new AI calls; existing gateway paths only.
- **Audit events:** none required — provenance stamping is metadata on an
  existing row via the same failure-soft worker step pattern as
  `stampOutcome` (no state machine transition, no money).
- **Human-approval gate / proposals:** untouched.
- Money/cents, catalog resolver, entity resolver: not touched.

## Implementation Units

### U1. `content-provenance.ts` classifier module
- **Goal:** one canonical trusted/untrusted decision for the three content
  kinds; the "decide" half pairing with `untrusted-content.ts`'s "render"
  half.
- **Requirements:** R1, R2 (the fail-closed rule lives here)
- **Dependencies:** none
- **Files:**
  - create `packages/api/src/ai/content-provenance.ts`
  - create `packages/api/test/ai/content-provenance.test.ts`
  - modify `packages/api/src/ai/untrusted-content.ts` (one-line module-doc
    cross-reference to the classifier)
- **Approach:** `type Provenance = 'trusted' | 'untrusted'`;
  `classifyMessageProvenance({senderRole})` → untrusted iff
  `senderRole === 'customer'`; `classifyTranscriptTurnProvenance({speaker})`
  → untrusted iff `speaker === 'caller'`;
  `classifyRecordingProvenance({source, transcriptMetadata})` uses BOTH
  markers: the existing `voice_recordings.source` column
  (`'inbound_call' | 'inapp_voice' | 'batch_upload'`, migration
  `054_p8_telephony_tables`) and the new `transcriptMetadata.provenance` —
  `source='inbound_call'` → untrusted regardless of metadata (caller audio
  is on the recording); `source='inapp_voice'` + metadata
  `provenance='operator'` (or agent-only turns) → trusted;
  `'batch_upload'`, missing/unknown source, or missing metadata provenance
  → **untrusted (fail closed)**. Plain types only, no repo imports.
- **Patterns to follow:** `packages/api/src/ai/untrusted-content.ts`
  (module shape, doc style).
- **Test scenarios:**
  - Happy: customer message → untrusted; owner/assistant/system sender →
    trusted; caller turn → untrusted; agent turn → trusted;
    `provenance:'operator'` → trusted; `'caller'`/`'mixed'` → untrusted.
  - Edge/fail-closed: `undefined` metadata, `{}` metadata, unknown
    provenance string, null → all untrusted.
- **Verification:** test file green; module imports nothing beyond types.

### U2. Swap suggest-reply's local `isCustomer` onto the classifier
- **Goal:** first real call site proves the classifier is a byte-identical
  drop-in before it fans out; deletes one of the three ad-hoc checks.
- **Requirements:** R1
- **Dependencies:** U1
- **Files:**
  - modify `packages/api/src/ai/tasks/suggest-reply-task.ts`
  - `packages/api/test/ai/tasks/suggest-reply-task.test.ts` (existing —
    must pass **unchanged**, incl. the pinned fence-marker strings and
    `Customer:`/`Shop:` lines)
- **Approach:** replace the local `isCustomer()` with
  `classifyMessageProvenance(...) === 'untrusted'`; remove the dead local
  helper (code-hygiene rule). No prompt-shape change of any kind.
- **Patterns to follow:** the existing import style for
  `untrusted-content.ts` in the same file.
- **Test scenarios:** existing suite green with zero assertion edits is
  the test — a pure refactor. If any assertion needs editing, the refactor
  is wrong.
- **Verification:** `npx vitest run test/ai/tasks/suggest-reply-task.test.ts`
  green without test changes.

### U3. `buildRecentMessagesPromptSections` + `resolveQueryText` treatment
- **Goal:** the reusable fence seam for all current/future
  `SourceContext.conversation.recentMessages` consumers; RAG query text
  explicitly documented as unfenced-by-design with a length cap.
- **Requirements:** R3, R4
- **Dependencies:** U1
- **Files:**
  - modify `packages/api/src/ai/orchestration/context-builder.ts`
  - modify `packages/api/src/ai/orchestration/retrieve-adapter.ts`
    (I13 comment on the query param; cap applied where the query is built —
    exact spot per existing structure)
  - create `packages/api/test/ai/orchestration/recent-messages-prompt-sections.test.ts`
  - existing suites that must stay untouched:
    `packages/api/test/ai/context-builder.test.ts`,
    `packages/api/test/ai/orchestration/context-builder.retrieve.test.ts`,
    `packages/api/test/ai/vertical-context-assembly.test.ts`
- **Approach:** helper partitions `recentMessages` via
  `classifyMessageProvenance`; trusted lines returned as plain
  `Role: content` strings; untrusted messages rendered through
  `buildUntrustedContentSection` into a single block
  (`{ trustedLines, untrustedBlock? }` shape — `untrustedBlock` absent when
  no customer messages, so consumers can spread-conditionally and stay
  byte-identical). `SourceContext`'s stored shape does NOT change.
  `resolveQueryText`: add `MAX_QUERY_CHARS` truncation + a comment stating
  the I13 rationale (embedding-only, never fence, never reuse in an LLM
  prompt without the helper).
- **Patterns to follow:**
  `buildStandingInstructionsSection` call-site pattern in
  `suggest-reply-task.ts` (separate system message, conditional spread);
  the fence usage in `summarize-session.ts`.
- **Test scenarios:**
  - Happy: mixed thread → customer lines inside exactly one fenced block
    (BEGIN/END markers present, hardening line present), owner/assistant
    lines in `trustedLines` un-fenced, original order preserved within each
    partition.
  - Edge: all-trusted thread → `untrustedBlock` absent; all-customer
    thread → empty `trustedLines`; empty `recentMessages` → both empty;
    customer message containing a forged END marker → neutralized
    (delegates to the fence helper, assert it survived the trip).
  - Query text: over-length input truncated to `MAX_QUERY_CHARS`; fence
    markers never appear in the query string.
  - Regression: the three existing context-builder suites pass unchanged.
- **Verification:** new suite green; the three existing suites green with
  zero edits.

### U4. `VoiceRepository.stampProvenance` (merge semantics)
- **Goal:** persistence primitive that adds `provenance` into
  `voice_recordings.transcript_metadata` without clobbering the rich
  metadata `transcription.ts` already writes.
- **Requirements:** R2
- **Dependencies:** none (parallel with U1–U3)
- **Files:**
  - modify `packages/api/src/voice/voice-service.ts` (interface: optional
    `stampProvenance?(tenantId, recordingId, provenance)`; doc comment on
    the `transcriptMetadata` field naming `provenance` as the I13 marker)
  - modify `packages/api/src/voice/pg-voice.ts` (JSONB `||` merge update)
  - modify the in-memory implementation in the same module pair
  - create `packages/api/test/integration/voice-recording-provenance.test.ts`
    (Docker-gated — JSONB merge semantics must be pinned against real
    Postgres; a mocked pool cannot prove `||` behavior or column names)
- **Approach:** single-column update mirroring `stampOutcome` /
  `stampDetectedLanguage`:
  `SET transcript_metadata = transcript_metadata || jsonb_build_object('provenance', $3)`
  under the existing tenant-scoped query pattern. Value domain
  `'caller' | 'mixed' | 'operator'` typed at the interface.
- **Patterns to follow:** `stampOutcome`/`stampDetectedLanguage` in the
  same files (optional method, failure semantics, tenant scoping);
  integration-test setup per
  `packages/api/test/integration/payment-reminder-dedup.test.ts` (shared
  test DB helpers).
- **Test scenarios (integration):**
  - Happy: stamp on a row whose `transcript_metadata` already carries
    `sanitization_version` etc. → provenance added AND prior keys intact
    (the merge-not-replace proof).
  - Edge: stamp on a fresh row (metadata `{}` default) → `{provenance}`;
    re-stamp with a different value → overwrites just that key.
  - Tenant isolation: stamping under tenant A never touches tenant B's row
    (RLS pin).
- **Verification:** integration test green under
  `npm run test:integration` config.

### U5. Ingestion worker computes + stamps provenance
- **Goal:** every transcript the live ingestion worker processes gets a
  provenance marker derived from the real per-turn speaker distribution.
- **Requirements:** R2
- **Dependencies:** U1, U4
- **Files:**
  - modify `packages/api/src/workers/transcript-ingestion-worker.ts`
  - modify `packages/api/test/workers/transcript-ingestion-worker.test.ts`
- **Approach:** new failure-soft step alongside `stampOutcome` /
  `stampDetectedLanguage`: from parsed turns, any caller turn + any agent
  turn → `'mixed'`; caller-only → `'caller'`; agent-only → `'operator'`
  (use `classifyTranscriptTurnProvenance` per turn rather than re-testing
  the speaker string). Log-and-continue on stamp failure — never fail the
  job. Skip when the repo lacks the optional method.
- **Patterns to follow:** the existing "Step 2a/2b" stamping blocks in the
  same worker and their tests (the stamp-called / stamp-not-called /
  stamp-throws-but-job-succeeds trio around lines ~207–260 of the test
  file).
- **Test scenarios:**
  - Happy: mixed transcript → `stampProvenance('mixed')` called with the
    right tenant/recording ids; caller-only voicemail-shaped transcript →
    `'caller'`; agent-only memo → `'operator'`.
  - Edge: zero parseable turns → no stamp call; repo without the optional
    method → no crash, job succeeds.
  - Failure path: `stampProvenance` throws → job still completes, warning
    logged (mirror the existing failure-soft assertions).
  - Explicit-assertion note: add positive `stampProvenance`-called
    assertions — do not rely on existing "does NOT call X" cases, which
    would silently under-cover the new call.
- **Verification:** worker suite green with the new trio of cases.

### U6. Cross-reference/doc pass
- **Goal:** the two-module pair (classifier + fence) reads as one system;
  future readers hit the I13 rationale at every seam.
- **Requirements:** R4, R5 (guards against future misuse)
- **Dependencies:** U1, U3, U4
- **Files:** touched-in-place doc comments only —
  `packages/api/src/ai/untrusted-content.ts`,
  `packages/api/src/voice/voice-service.ts`,
  `packages/api/src/ai/orchestration/context-builder.ts` (already edited in
  U3; verify the comments landed), plus one line in
  `docs/verification-runs/rivet-production-gate-2026-07-24.md` updating the
  I13 residual status.
- **Approach:** comments state constraints code can't express: fail-closed
  rule, never-fence-the-embedding-query, check-provenance-before-quoting-
  transcript-into-a-prompt.
- **Test scenarios:** `Test expectation: none — documentation-only unit.`
- **Verification:** `npx tsc --project tsconfig.build.json --noEmit` clean.

## Context facts the implementer should not re-derive

Verified during planning (Explore + Plan agents, 2026-07-24):

- `buildSourceContext` has **no production caller** — `app.ts:2233-2252`
  builds the retrieve adapter then `void retrieveAdapter;` ("Phase 4b").
  U3 establishes the pattern before the first consumer exists; there is no
  live prompt to regress.
- **No production code reads `voice_recordings.transcript` from the DB into
  an LLM prompt** — prompt-bound transcripts flow in-memory/by-queue from
  the transcription event; the DB column is read only by UI routes
  (`routes/voice.ts:521`) and non-prompt lookups. U4/U5 are forward-looking
  hardening plus the marker the contract requires.
- Every live task handler already places caller text strictly in
  `role:'user'` and owner/system content in `role:'system'` — consistent
  trust placement; this plan does not change it.
- Migrations are entries in the `MIGRATIONS` object in
  `packages/api/src/db/schema.ts` (latest key: `261_create_tenant_entity_aliases`),
  concatenated by `getMigrationSQL()` and run by `src/db/migrate.ts` under an
  advisory lock — **U4 needs no new migration** (`transcript_metadata JSONB
  DEFAULT '{}'` exists since `007_create_voice_recordings`; `source` since
  `054_p8_telephony_tables`).

## Risks & Dependencies

- **Prompt-shape-pinned suites** are the main regression surface:
  `suggest-reply-task.test.ts` pins exact fence bytes (U2 must be a
  zero-edit refactor); the three context-builder suites assert raw
  `recentMessages.content` (U3 must not mutate `SourceContext`).
- **Voice-quality cassette suites** pin live-call prompt bytes — out of
  scope by design; any temptation to fence live in-call turns breaks them
  and changes the caller experience. Explicit non-goal.
- **Retrieval-quality regression** if the fence ever wraps the embedding
  query — no CI eval would catch it (mitigated by comment + cap, follow-up
  eval idea deferred).
- **Optional-method silent no-op**: a test double implementing
  `VoiceRepository` without `stampProvenance` won't compile-break; U5's
  explicit called-with assertions are the guard.
- `transcript-ingestion-worker.ts`'s docstring still claims
  `call_transcript_turns` has "no production writer" — stale (it is
  registered in `app.ts` when an embedding provider is configured); U5
  should correct the comment in passing.

## Open Questions (deferred to implementation)

- Exact `MAX_QUERY_CHARS` value — pick against the embedding provider's
  practical input budget at implementation time (a few hundred chars is the
  expected order; measure, don't guess in the plan).
- Whether `pg-voice.ts` needs a `COALESCE(transcript_metadata, '{}')`
  guard despite the column's `'{}'` default — confirm against the real
  schema in the U4 integration test.
- Precise helper/type names — the plan's names are intents, not contracts.

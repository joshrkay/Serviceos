# Wave 1 — Batch D — U4 Privacy and data handling

**Branch:** `fix/ai-hardening-privacy`  
**Execution plan:** `docs/plans/2026-10-18-003-chore-ai-hardening-execution-plan.md` (E3 protocol)  
**Technical plan:** `docs/plans/2026-10-18-002-fix-ai-enterprise-hardening-plan.md` unit U4 (PR #1695)  
**Audit baseline:** `origin/main` `20637e004`. Every file:line below is against that commit; re-verify before editing.

## Findings in this batch

| ID | Severity (verified) | Verdict | Title |
|---|---|---|---|
| PRIV-3 | high | confirmed | No card-number (PAN) detection anywhere: a card recited on a call is persisted in 5+ stores and sent to the LLM provider, ai_runs and Langfuse |
| PRIV-2 | high | confirmed | Retention sweep deletes only the S3 copy of each call recording; the Twilio-hosted original is never deleted and recording_url keeps pointing at it |
| PRIV-1 | high | confirmed | ai_runs stores verbatim prompts and completions (full call transcripts, caller PII) in plaintext forever; the C6 retention sweep never touches it |
| PRIV-4 | medium | confirmed | The AI-identity disclosure skill is built and unit-tested but never wired; production calls replace the FSM's 'I'm a virtual assistant' line with a greeting that has no AI disclosure |
| PRIV-6 | low | partial | Langfuse content export sends every tenant's prompts and transcripts to a third party behind one global flag, with a regex 'redaction' that lets names, addresses and PANs through and no deprovision purge |

## Build order and sequencing

Build order inside the batch:

1. **PRIV-3** first: the Luhn-validated PAN scrubber in a new `packages/api/src/ai/privacy/pan-redact.ts`
   is a pure module every later step calls. Apply at `callerTranscriptText`, user-role text in
   `LLMGateway.complete` (ONE hunk, before dispatch and before the snapshot), `redactTextForExport`,
   `scrubPii` (residual detector flags grouped digits), `redact=pci` on Deepgram, and the recording
   `pci_detected` mark that the retention worker honours. If `pci_detected` needs a column, it is
   migration `314_...` (idempotent) with its snapshot row.
2. **PRIV-2**: the Twilio deleter behind an injectable seam (never logs the auth token); delete the
   Twilio copy only after the S3 PUT and DB insert succeed; URL built from `recording_url`
   (subaccounts), 404 treated as done; sweep retries legacy and failed rows; purge audit records
   `twilioDeleted`. Never null `recording_url`.
3. **PRIV-1**: the `ai_runs` content-purge phase in `RecordingRetentionWorker`, shaped like the #1208
   `voice_sessions` phase: cross-tenant tenant selection, then per-tenant UPDATE under the tenant
   transaction, bounded by `(tenant_id, created_at)`, rows kept (FKs from `proposals` and
   `supervisor_reviews`), every task type scrubbed, one audit event per tenant batch. It reuses the
   PRIV-2 purge/audit shape and the PRIV-3 `pci_detected` prompt-purge.
4. **PRIV-4**: every telephony greeting branch includes the plain disclosure; per-tenant wording
   override kept; ledgered like `discloseRecording`; not gated on caller state. Only
   `bootstrapCallEstablishment` / `buildTelephonyGreeting` in `twilio-adapter.ts`.
5. **PRIV-6** last: config refuses `LANGFUSE_CAPTURE_CONTENT=true` in production or staging unless
   the base URL is self-hosted or an explicit acknowledgement variable is set.
6. Delete `packages/api/src/ai/evaluation/dataset-hooks.ts` (unimported on main; re-grep first) and
   any test that only exists for it.

## File ownership and hot spots

- `packages/api/src/telephony/twilio-adapter.ts`: you own ONLY `bootstrapCallEstablishment` and
  `buildTelephonyGreeting`; batch E owns the rest.
- `packages/api/src/voice/transcription-providers.ts`: you own ONLY the `redact=pci` parameter in
  `buildWsUrl`; batch E owns the Deepgram final aggregation.
- `packages/api/src/ai/gateway/gateway.ts`: ONE hunk (PAN scrub of user-role text). Batch C owns the
  rest of the gateway in wave 3.
- `packages/api/src/shared/config.ts`: the PRIV-6 guard, small and self-contained.
- `packages/api/src/app.ts`: wiring only.
- Migration: if needed, `314_...`; batch E has none, so no collision inside wave 1.

## The unit as ruled in the technical plan (verbatim; this ruling wins)

### U4. Privacy and data handling — batch D, `fix/ai-hardening-privacy`

- **Goal:** caller data honours the retention promise. Card numbers are never stored or sent to a
  provider. Callers are told they are talking to an AI.
- **Requirements:** R1, R2, R4, R5
- **Dependencies:** none (U7 depends on it)
- **Findings:** PRIV-1, PRIV-2, PRIV-3 (high); PRIV-4 (medium); PRIV-6 (low).
- **Files:**
  - `packages/api/src/workers/recording-retention-worker.ts`
  - `packages/api/src/telephony/{recording-webhook,voicemail-status-route,recording-control}.ts`
  - a new `packages/api/src/ai/privacy/pan-redact.ts`
  - `packages/api/src/ai/voice-turn/transcript-append.ts`
  - one hunk in `packages/api/src/ai/gateway/gateway.ts`
  - `redactTextForExport` and `scrubPii`
  - one parameter in `packages/api/src/voice/transcription-providers.ts` `buildWsUrl`
  - `bootstrapCallEstablishment` / `buildTelephonyGreeting` in
    `packages/api/src/telephony/twilio-adapter.ts`
  - `packages/api/src/ai/skills/disclose-ai-identity.ts`
  - `packages/api/src/shared/config.ts`
  - delete `dataset-hooks.ts` if it is unimported
  - Tests: next to each module, plus new integration files.
- **Approach:**
  - **PRIV-1**
    - Add an `ai_runs` content-purge phase to `RecordingRetentionWorker`, shaped like the #1208
      `voice_sessions` phase.
    - Select tenants cross-tenant, then run each per-tenant `UPDATE` under the tenant transaction.
    - Bound batches with the `(tenant_id, created_at)` index.
    - Keep the row, so the FKs from `proposals` and `supervisor_reviews` survive.
    - Scrub every task type, and write one audit event per tenant batch.
  - **PRIV-2**
    - Delete the Twilio copy only after the S3 PUT and the DB insert succeed.
    - Build the URL from `recording_url`, which covers subaccounts. Treat 404 as done.
    - The sweep retries legacy and failed rows, and the purge audit records `twilioDeleted`.
    - Do NOT null `recording_url`; it is the idempotency key.
    - Put the deleter behind an injectable seam, and never log the auth token.
  - **PRIV-3**
    - One Luhn-validated scrubber: 13–19 digits, optional space or dash groups, replaced with
      `[card number]`.
    - Apply it at:
      - `callerTranscriptText`
      - user-role text in `LLMGateway.complete`, before dispatch and before the snapshot
      - `redactTextForExport`
      - `scrubPii`, whose residual detector also flags grouped digits
    - Add `redact=pci` to Deepgram.
    - Mark the recording `pci_detected` so the retention worker purges its audio promptly from S3 and
      Twilio.
  - **PRIV-4**
    - Every telephony greeting branch, including custom tenant greetings, includes a plain disclosure
      such as "I'm a virtual assistant".
    - Keep the per-tenant wording override.
    - Ledger it the same way `discloseRecording` does.
    - Do not gate it on the caller's state, which is an unreliable area-code proxy.
  - **PRIV-6:** the config refuses `LANGFUSE_CAPTURE_CONTENT=true` in production or staging, unless
    the base URL is self-hosted or an explicit acknowledgement variable is set.
- **Test scenarios:**
  - **Unit, scrubber:**
    - Luhn-valid PANs are scrubbed, grouped or not.
    - Non-Luhn digit runs and phone numbers are untouched.
    - An unspaced PAN no longer leaks its first five digits through the exporter.
  - **Unit:** the deleter treats 404 as done and keeps the token out of logs.
  - **Unit:** each greeting branch contains the disclosure.
  - **Unit:** the config guard rejects and accepts the right combinations.
  - **Integration (PRIV-1),** RLS on:
    - only rows older than retention are scrubbed
    - FKs stay intact
    - newer rows are untouched
  - **Integration:** the recording flow inserts the row, then deletes the Twilio copy; a failed delete
    is retried by the sweep.
- **Verification:** a PAN read aloud never reaches `ai_runs`, `call_transcript_turns` or the provider
  payload in tests.

## Per-finding work packages

Precedence for each finding: the plan ruling above, then the verifier's corrected fix, then the auditor's fix. Trigger, impact, evidence and reasoning are quoted in full from the audit so the implementer and the reviewer trace the same production path.

### PRIV-3 — No card-number (PAN) detection anywhere: a card recited on a call is persisted in 5+ stores and sent to the LLM provider, ai_runs and Langfuse

- **Severity:** high (auditor said high). **Verdict:** confirmed. **Dimension:** privacy.
- **Locations (audit baseline):**
  - `packages/api/src/voice/transcription-providers.ts:480-484`
  - `packages/api/src/ai/voice-turn/transcript-append.ts:61-66`
  - `packages/api/src/telephony/twilio-adapter.ts:2044-2050`
  - `packages/api/src/telephony/twilio-adapter.ts:2296-2302`
  - `packages/api/src/ai/agents/customer-calling/voice-session-store.ts:849-858`
  - `packages/api/src/ai/orchestration/intent-classifier.ts:3228-3237`
  - `packages/api/src/ai/gateway/gateway.ts:551`
  - `packages/api/src/ai/gateway/trace-exporter.ts:146-153`
  - `packages/api/src/ai/training/scrub.ts:191`
  - `packages/api/src/workers/transcript-ingestion-worker.ts:348-375`
  - `packages/api/src/db/schema.ts:1654-1662`
  - `spec/RIVET_COMMS_SPEC.md:94`

**Trigger (the real production path):**

A known caller asks their balance. lookup_balance (ai/skills/lookup-balance.ts) answers 'you owe $X', and the caller says 'can I just pay now — my card is 4111 1111 1111 1111, expires 09/27'. On Media Streams, Deepgram runs with smart_format=true and no redaction (transcription-providers.ts:484), so it returns formatted digits. On Gather, Twilio STT returns them raw. twilio-adapter.ts:2048/2301 appends `callerTranscriptText(session, speechResult)` verbatim, because it redacts only the voice-approval challenge stage (transcript-append.ts:61-66). From there the text goes to call_transcript_turns (voice-session-store.ts:851) and voice_sessions.transcript, the classify_intent prompt to OpenAI/OpenRouter (intent-classifier.ts:3229), ai_runs.input_snapshot (gateway.ts:551, never purged, see PRIV-1), Langfuse when content capture is on, and knowledge_chunks.content via the ingestion worker. The Twilio call recording captures the audio as well.

**Impact:**

Payment card data reaches a third-party LLM, a third-party trace backend, and at least five Postgres stores, one of them with no retention at all. That pulls the transcript and recording stores, the ai_runs table, and the subprocessors into PCI DSS scope. The repo's own spec requires the opposite: 'no card number should ever reach a transcript. If one does ... detect and redact rather than assume compliance holds' (RIVET_COMMS_SPEC.md:94). Any enterprise security review will block on this.

**Evidence:**

`grep -rniE 'luhn|card[_ ]?number|credit card|\bpci\b' packages/api/src` returns no production hits. transcription-providers.ts:482-484: `'wss://api.deepgram.com/v1/listen' + ?model=...&interim_results=true&smart_format=true&endpointing=...` (no redact parameter). transcript-append.ts:65: `return session?.pendingVoiceApproval?.stage === 'challenge' ? REDACTED_CHALLENGE_TEXT : spoken;`. ai/training/scrub.ts:191 `DIGIT_RUN_REGEX = /[0-9]{7,}/g` misses space-grouped PANs. I ran a throwaway probe against the real exporter (scratchpad/probe/redact-probe.ts): redactTextForExport('caller: my card is 4111 1111 1111 1111 expiration oh nine twenty seven cvv 123') returned the input unchanged.

**Verifier's reasoning (what is real, what was narrowed):**

I grepped packages/api/src for luhn, pci, card number and credit card and found no matches. The spec requires detection (RIVET_COMMS_SPEC.md:94, citing D13). callerTranscriptText only redacts the voice-approval challenge stage (transcript-append.ts:65). Both Twilio append sites (twilio-adapter.ts:2048, 2301) and the voice-turn processor use it, so caller speech is stored verbatim. The Deepgram URL has smart_format=true and no redact parameter (transcription-providers.ts:482-484). knowledge_chunks.content stores scrub.text, which the ScrubResult doc says is 'Original text, unmodified' (ingestion worker emitChunk). I ran redactTextForExport and scrubPii myself. A spaced PAN '4111 1111 1111 1111' came back unchanged from both, and scrubPii reported residual=false. An unspaced PAN came back from the exporter as '41111[phone]', which leaks the first five digits. The trigger depends on the caller reciting a card unprompted, since nothing asks for one and payments go through Stripe links. Once that happens, the stores listed (transcript turns, voice_sessions.transcript, knowledge_chunks.content, ai_runs, the LLM provider, Langfuse if content capture is on) all receive the PAN, along with the Twilio and S3 audio. High is reasonable because it pulls those stores into PCI scope, though it is incidental capture rather than systematic.

**Fix to implement (verifier's corrected fix):**

Keep the Luhn-validated scrubber (13-19 digits, optional space or dash groups) and apply it at callerTranscriptText, on user-role text in LLMGateway.complete before dispatch and snapshot, and in redactTextForExport and scrubPii, where the residual detector should also flag grouped digits. Add redact=pci to the Deepgram URL. Twilio Gather speechResult cannot be redacted upstream, so the app-side chokepoint is the main control. Drop 'pauseRecording on detection' as the audio control: detection happens after the utterance, so the PAN is already in that recording. Instead flag the recording (e.g. pci_detected) and purge or trim its audio from S3 and from Twilio (see PRIV-2), then speak a deterministic line telling the caller not to read card numbers and that a pay link will be texted. Pausing is only useful as an extra step for anything said after detection.

**Auditor's original fix (superseded where the corrected fix differs):**

Add one Luhn-validated PAN scrubber, e.g. ai/privacy/pan-redact.ts: 13-19 digits with optional space or dash separators that pass the Luhn check become '[card number]'. Apply it at the existing chokepoints: (a) inside callerTranscriptText, so every stored turn and everything derived from it inherits it, as #850 already does for the PIN; (b) in LLMGateway.complete on user-role text before dispatch and snapshot; (c) in redactTextForExport and in scrub.ts's residual detector. Add `&redact=pci` to the Deepgram buildWsUrl. On a detected PAN, call the existing RecordingControl.pauseRecording seam (RV-130) and speak a deterministic line pointing the caller to the pay link.

**Test specification (from the audit):**

Unit tests for pan-redact: Luhn-valid 16- and 15-digit PANs, spaced and dashed, are redacted; a 16-digit non-Luhn run, a 10-digit phone number and integer cents are untouched. Handler-level test on both adapters with a mocked gateway and store: a speechResult containing a PAN produces a stored transcript turn and gateway request messages with no PAN, and pauseRecording is called once. A buildWsUrl unit test pins `redact=pci`. Extend trace-exporter.test.ts with a PAN sample.

**Acceptance criteria:**

- [ ] A test exists that fails on `origin/main` (or with this finding's fix hunk reverted) for the reason the trigger describes, and passes on the branch.
- [ ] The fix is reached from the trigger's real callers (trace recorded in the PR body), not only from the test.
- [ ] No caller of a changed function regressed; every existing test stays green or its pin is changed with the reason in the commit message.
- [ ] Dead code made dead by this fix is deleted in the same commit.
- [ ] Commit `fix(<area>): <defect in plain words>` names PRIV-3 in the body and ends with the session trailers.

### PRIV-2 — Retention sweep deletes only the S3 copy of each call recording; the Twilio-hosted original is never deleted and recording_url keeps pointing at it

- **Severity:** high (auditor said high). **Verdict:** confirmed. **Dimension:** privacy.
- **Locations (audit baseline):**
  - `packages/api/src/telephony/recording-webhook.ts:336-353`
  - `packages/api/src/telephony/voicemail-status-route.ts:472-478`
  - `packages/api/src/workers/recording-retention-worker.ts:785-790`
  - `packages/api/src/workers/recording-retention-worker.ts:209-218`
  - `packages/api/src/voice/voice-service.ts:583-594`
  - `packages/api/src/telephony/recording-control.ts:108-112`

**Trigger (the real production path):**

Every inbound AI call arms `<Start><Record>` (twilio-adapter.ts:751-757). When the recording completes, the webhook fetches the MP3 from Twilio with platform credentials, PUTs it to S3, and inserts voice_recordings with recording_url (recording-webhook.ts:339-363). Voicemail follows the same path (voicemail-status-route.ts:472-478). Past recording_retention_days, RecordingRetentionWorker calls `deps.storage.deleteObject(bucket, key)` (recording-retention-worker.ts:787-788) and stamps purged_at. The Twilio recording resource is never deleted at ingest, at purge, or anywhere else, and recording_url is left on the row.

**Impact:**

Call audio (caller voice, everything said, including any PAN from PRIV-3) lives indefinitely at a third party, past the tenant's retention horizon and past legal 'deletion'. The purge audit event (`voice_recording.purged` with hadStoredObject) tells the operator the audio is gone when the primary copy still exists and is fetchable through the retained recording_url with account credentials. That is a false deletion record for SOC 2 / DPA purposes.

**Evidence:**

recording-webhook.ts:339-353: `const bytes = await fetchRecording(recordingUrl, deps.twilioAccountSid, deps.twilioAuthToken); ... await uploadObject(uploadUrl, bytes, contentType);`, with no DELETE afterwards. Repo-wide grep for Twilio recording deletion (`Recordings/`, `.recordings`, `method: 'DELETE'`) finds only the pause call `/Calls/{CallSid}/Recordings/Twilio.CURRENT.json` with Status=paused (recording-control.ts:108-112). recording-retention-worker.ts:787-788: `if (row.storageBucket && row.storageKey) { await deps.storage.deleteObject(row.storageBucket, row.storageKey); }`. markPurged (209-218) only sets purged_at. purgeDerived (221-255) nulls transcript but not recording_url.

**Verifier's reasoning (what is real, what was narrowed):**

recording-webhook.ts:339-353 and voicemail-status-route.ts:460-472 fetch the MP3 from Twilio, PUT it to S3 and insert voice_recordings with recording_url. Neither deletes the Twilio resource. A repo grep finds only one Twilio Recordings call, the pause in recording-control.ts:111. The retention sweep calls storage.deleteObject on the S3 key only (recording-retention-worker.ts:787-788). markPurged only sets purged_at, and the voice_recording.purged audit event records hadStoredObject. The Twilio original therefore outlives the tenant's retention horizon and the purge record. Nothing in the code configures Twilio-side external storage or auto-delete either; the docs do not mention one. Tenant deprovision closes the Twilio subaccount, which Twilio purges after about 30 days, so the gap is limited to per-recording retention and per-subject deletion. Those are exactly the paths that matter. Nothing reads recording_url after insert, so deleting the Twilio copy right after the S3 upload breaks no downstream consumer.

**Fix to implement (verifier's corrected fix):**

Make two changes to the proposed fix. (1) Do not null voice_recordings.recording_url in markPurged. It is the per-recording idempotency key in recordInboundCall (voice-service.ts:539-545), and once the Twilio resource is gone it is a dead pointer that holds no PII. (2) Build the DELETE URL from the recording URL itself (/2010-04-01/Accounts/{AC}/Recordings/{RE}.json), not from the platform AccountSid. Calls run on per-tenant subaccounts (integrations/twilio/provisioning.ts), so the recording lives under the subaccount; master credentials can delete it on that path. The rest stands: delete after the S3 PUT and DB insert succeed, treat 404 as done, retry from the sweep for legacy or failed rows, and record twilioDeleted in the purge audit metadata.

**Auditor's original fix (superseded where the corrected fix differs):**

S3 is the system of record, so delete the Twilio copy right after a successful S3 upload and DB insert in recording-webhook.ts and voicemail-status-route.ts: `DELETE /2010-04-01/Accounts/{AccountSid}/Recordings/{RecordingSid}.json` behind an injectable `TwilioRecordingDeleter` seam shaped like RecordingControl (timedFetch, auth token never logged, 404 treated as done, failure logged and retried by a sweep). For legacy rows, add the same delete to the retention worker's per-row purge, derived from the RecordingSid embedded in recording_url, and null voice_recordings.recording_url in markPurged. Record `twilioDeleted` in the purge audit metadata.

**Test specification (from the audit):**

Unit tests with mocked fetch: the webhook issues the DELETE only after the S3 PUT and the insert succeed, never when the upload fails, and treats 404 as success; the retention worker issues the Twilio delete for a legacy row and records it in the audit event. Docker-gated integration test pinning that markPurged nulls recording_url (real column) and that a re-run is idempotent.

**Acceptance criteria:**

- [ ] A test exists that fails on `origin/main` (or with this finding's fix hunk reverted) for the reason the trigger describes, and passes on the branch.
- [ ] The fix is reached from the trigger's real callers (trace recorded in the PR body), not only from the test.
- [ ] No caller of a changed function regressed; every existing test stays green or its pin is changed with the reason in the commit message.
- [ ] Dead code made dead by this fix is deleted in the same commit.
- [ ] Commit `fix(<area>): <defect in plain words>` names PRIV-2 in the body and ends with the session trailers.

### PRIV-1 — ai_runs stores verbatim prompts and completions (full call transcripts, caller PII) in plaintext forever; the C6 retention sweep never touches it

- **Severity:** high (auditor said high). **Verdict:** confirmed. **Dimension:** privacy.
- **Locations (audit baseline):**
  - `packages/api/src/ai/gateway/gateway.ts:372`
  - `packages/api/src/ai/gateway/gateway.ts:401-416`
  - `packages/api/src/ai/gateway/gateway.ts:546-555`
  - `packages/api/src/ai/gateway/gateway.ts:635-640`
  - `packages/api/src/ai/gateway/cache.ts:185-210`
  - `packages/api/src/ai/skills/summarize-session.ts:198-207`
  - `packages/api/src/ai/voice-turn/create-voice-turn-processor.ts:3968`
  - `packages/api/src/ai/orchestration/intent-classifier.ts:3228-3237`
  - `packages/api/src/workers/recording-retention-worker.ts:221-255`
  - `packages/api/src/workers/recording-retention-worker.ts:386-392`
  - `packages/api/src/db/schema.ts:175-192`
  - `packages/api/src/db/schema.ts:4282-4284`
  - `spec/RIVET_COMMS_SPEC.md:90`

**Trigger (the real production path):**

A homeowner calls a tenant's AI line. Every final utterance goes to classify_intent (intent-classifier.ts:3229). At hangup, runSummary calls summarizeSession (create-voice-turn-processor.ts:3968 -> summarize-session.ts:198), which sends every agent and caller turn under the tenant's id. LLMGateway.complete then writes each request's messages to ai_runs.input_snapshot (gateway.ts:551) and the reply to output_snapshot.content (gateway.ts:639); cache hits write the same thing again (cache.ts:190-207). Once the call passes tenant_settings.recording_retention_days (default 365, with no write surface per schema.ts:4282), RecordingRetentionWorker purges voice_recordings.transcript, call_transcript_turns, call_summaries, knowledge_chunks and voice_sessions.transcript. The same transcript and summary are still in ai_runs.

**Impact:**

The tenant's retention horizon and the spec's own C6 rule ('A deletion capability that misses derived data is not a deletion capability', RIVET_COMMS_SPEC.md:90) are broken for the largest copy of caller speech. Every call's names, addresses, phone numbers, and anything else spoken stay in plaintext JSONB indefinitely. That includes the call summary the sweep just deleted from call_summaries. ai_runs has no customer or session key (schema.ts:175-192), so the rows can't even be found for one data subject. Nothing in production reads this content: the only reader is ai/evaluation/dataset-hooks.ts, which has no callers. The table is pure liability, and an enterprise DPA/SOC 2 retention review will block on it.

**Evidence:**

gateway.ts:371-373: "Redact image payloads ... before they are written to an ai_runs input snapshot. Text is preserved for debugging". gateway.ts:550-551: `inputSnapshot: { messages: redactMessagesForSnapshot(request.messages), ...`. redactMessagesForSnapshot returns `{ role: m.role, content: m.content }` unchanged for text (gateway.ts:405-406). gateway.ts:637-640: `const outputFields = { content: result.content, provider: result.provider }`. summarize-session.ts:203: `messages: [{ role: 'user', content: sections.join('\n\n') }]`, where sections holds every agent and caller line. recording-retention-worker.ts:221-255 purgeDerived deletes only call_transcript_turns, call_summaries and knowledge_chunks and nulls voice_recordings.transcript. Neither it nor any other module issues UPDATE/DELETE on ai_runs (grep: the only ai_runs UPDATE is pg-ai-run.ts:145, the status write). Contrast: PgShadowComparisonStore.save runs redactText() before storage (pg-shadow-comparison.ts:122-124). ai_runs gets no such pass.

**Verifier's reasoning (what is real, what was narrowed):**

I checked this against the code and it holds. app.ts:1499 builds the production gateway with aiRunRepo, which is PgAiRunRepository whenever a pool exists (build-repositories.ts:552). Every gateway.complete call writes inputSnapshot.messages through redactMessagesForSnapshot, and that function returns text content unchanged (gateway.ts:405-406). The completed reply goes into output_snapshot.content (gateway.ts:637-640). Two callers I traced send caller speech here. classify_intent puts the caller transcript in the user message (intent-classifier.ts:3228-3237). summarize_conversation sends every agent and caller line (summarize-session.ts:198-207, called from runSummary). The table's only writes are the INSERT and the status UPDATE in pg-ai-run.ts. No worker, migration or cron purges or nulls it; the only DELETEs are in integration tests. RecordingRetentionWorker.purgeDerived covers call_transcript_turns, call_summaries, knowledge_chunks and voice_recordings.transcript, and the #1208 phase covers voice_sessions.transcript. None of these touch ai_runs. So the call summary the sweep deletes from call_summaries survives in ai_runs.output_snapshot. Nothing in production reads the content: dataset-hooks.ts is test-only, and proposal-linkage.ts findById has no importers. The schema has no session or customer column. Only tenant deprovision removes the rows, through the generic tenant_id DELETE. One minor overstatement: the cache-hit duplicate write in cache.ts only happens with AI_CACHE_ENABLED=true, which is off by default. That does not change the finding.

**Fix to implement (verifier's corrected fix):**

The auditor's fix is sound with two adjustments. (a) Run the per-tenant UPDATE under withTenant / withTenantTransaction, because ai_runs has an RLS policy keyed on app.current_tenant_id. Select tenants cross-tenant the same way the #1208 phase does, and bound each batch with an id subselect that uses the existing (tenant_id, created_at) index. (b) Scrub every task type, not only voice: supervisor_review rows store proposal payloads, and system prompts carry CRM context. Write-time scrubbing is defense in depth only, because the regex scrubber misses lowercase spoken names and addresses (see PRIV-6). The purge is the real control. Deleting dataset-hooks.ts and the unimported proposal-linkage.ts in the same change is correct hygiene.

**Auditor's original fix (superseded where the corrected fix differs):**

Two parts in the repo's idiom. (1) Add an ai_runs content phase to RecordingRetentionWorker, shaped like the #1208 voice_sessions phase: cross-tenant tenant selection via tenant_settings and LATERAL, then per tenant `UPDATE ai_runs SET input_snapshot = jsonb_build_object('purged_at', $now), output_snapshot = output_snapshot - 'content' WHERE tenant_id=$1 AND created_at < $now - make_interval(days => recording_retention_days) AND NOT (input_snapshot ? 'purged_at')`, bounded through a ctid/id subselect LIMIT. Keep the row so proposals.ai_run_id and supervisor_reviews FKs survive, and write one `ai_run.content_purged` audit event per tenant batch. (2) Defense in depth at write time: apply the same free-text scrub the exporter already uses (redactTextForExport) to text in redactMessagesForSnapshot and to outputFields.content in gateway.ts and cache.ts. Once nothing reads the content, consider persisting only role, length and sha256 per message. Delete the dead ai/evaluation/dataset-hooks.ts in the same change.

**Test specification (from the audit):**

Docker-gated integration test in packages/api/test/integration/ (real Postgres, RLS_RUNTIME_ROLE=true). Seed tenant A with recording_retention_days=1, one ai_runs row created 2 days ago carrying a transcript in input_snapshot.messages plus output_snapshot.content, one 1-hour-old row, and a proposal whose ai_run_id points at the old row; seed tenant B with an old row and retention 365. Run the real repository and sweep phase. Assert A's old row has no message text or content and still exists with the proposal FK intact, A's fresh row is untouched, B's row is untouched, and one audit event was written. Add a unit test in test/workers/recording-retention-worker.test.ts for phase orchestration (per-tenant failure isolation, batch bound), and a gateway unit test asserting the persisted snapshot carries no raw phone or email from a request.

**Acceptance criteria:**

- [ ] A test exists that fails on `origin/main` (or with this finding's fix hunk reverted) for the reason the trigger describes, and passes on the branch.
- [ ] The fix is reached from the trigger's real callers (trace recorded in the PR body), not only from the test.
- [ ] No caller of a changed function regressed; every existing test stays green or its pin is changed with the reason in the commit message.
- [ ] Dead code made dead by this fix is deleted in the same commit.
- [ ] Commit `fix(<area>): <defect in plain words>` names PRIV-1 in the body and ends with the session trailers.

### PRIV-4 — The AI-identity disclosure skill is built and unit-tested but never wired; production calls replace the FSM's 'I'm a virtual assistant' line with a greeting that has no AI disclosure

- **Severity:** medium (auditor said medium). **Verdict:** confirmed. **Dimension:** privacy.
- **Locations (audit baseline):**
  - `packages/api/src/ai/skills/disclose-ai-identity.ts:1-26`
  - `packages/api/src/ai/skills/disclose-ai-identity.ts:90-109`
  - `packages/api/src/ai/agents/customer-calling/transitions.ts:862`
  - `packages/api/src/ai/agents/customer-calling/tts-copy.ts:253-256`
  - `packages/api/src/telephony/twilio-adapter.ts:1269-1279`
  - `packages/api/src/telephony/twilio-adapter.ts:1344-1349`
  - `packages/api/src/telephony/twilio-adapter.ts:532-557`
  - `packages/api/src/ai/i18n/en.ts:61-63`
  - `packages/api/src/telephony/media-streams/mediastream-adapter.ts:2764-2783`
  - `packages/api/src/settings/voice-persona-resolver.ts:91-92`

**Trigger (the real production path):**

Any inbound PSTN call to an AI line, including callers from California, where the skill's own header says disclosure is required. The FSM emits `ttsPlay('greeting', { template: 'greeting_with_disclosure' })` (transitions.ts:862), which would render "Hi, I'm a virtual assistant" (tts-copy.ts:254). On both transports, bootstrapCallEstablishment substitutes buildTelephonyGreeting(...) for the placeholder (twilio-adapter.ts:1344), and the media-streams adapter then strips the template hint (mediastream-adapter.ts:2779-2783). The caller hears 'Thank you for calling {business}. This is {agentName}.' plus the recording notice. With a tenant-set voiceAgentName (voice-persona-resolver.ts:91), the AI introduces itself under a human name. resolveAiDisclosure / buildAiDisclosureText have zero production importers (grep).

**Impact:**

Callers are never told they are talking to an AI, and with a persona name the bot affirmatively presents as a named person. That is the scenario bot- and AI-disclosure laws target; the skill names California's B.O.T. Act, Cal. Bus. & Prof. Code §17940. An enterprise legal review will block on a disclosure control the codebase built and silently never ran. Per CLAUDE.md this is the 'built but never wired' class.

**Evidence:**

disclose-ai-identity.ts:4-11: "This discloses that the caller is speaking with an AI. Bot-disclosure laws in some states require it (e.g. California's B.O.T. Act, SB 1001). Played at call start, after the greeting ... the greeting-path wiring + consent-ledger/audit are the integration layer." `grep -rn 'resolveAiDisclosure|buildAiDisclosureText|requiresAiDisclosure' src` (excluding the module and tests) returns nothing. twilio-adapter.ts:1270 calls only `discloseRecording({...})`, and nothing passes callerState. en.ts:61-62: `'greeting.opener_default': 'Thank you for calling {{business}}.'`, `'greeting.opener_named': 'Thank you for calling {{business}}. This is {{agent}}.'`.

**Verifier's reasoning (what is real, what was narrowed):**

disclose-ai-identity.ts exports requiresAiDisclosure, buildAiDisclosureText and resolveAiDisclosure. A grep of src outside the module finds no importers. bootstrapCallEstablishment calls only discloseRecording (twilio-adapter.ts:1270) and replaces the FSM greeting placeholder with buildTelephonyGreeting (twilio-adapter.ts:1344). Both transports go through it (twilio-adapter.ts:1571 for streams). That greeting is assembled from 'Thank you for calling {business}.' or '... This is {agent}.' plus the recording notice ('This call may be recorded for quality and training purposes...'), and neither says AI. The media-streams adapter strips the template hint once the text is substituted (mediastream-adapter.ts:2779-2783), so the FSM's 'Hi, I'm a virtual assistant' (tts-copy.ts:254) is never spoken. Nothing in the voice prompts or copy discloses AI identity later either; my grep found none. voiceAgentName from tenant_settings becomes the spoken agent name (voice-persona-resolver.ts:91). The legal impact is somewhat overstated. California's B.O.T. Act (SB 1001) targets bots on online platforms used to mislead for a sale or a vote, and whether it covers inbound PSTN calls is unclear. But a disclosure control that was built and silently never run, plus a human persona name, is a real compliance and trust gap. Medium is right.

**Fix to implement (verifier's corrected fix):**

Do not gate on placePhone(from).state. Area code is a weak proxy for where the caller is (ported mobiles, VoIP), and the module returns false for an unknown state, which contradicts the 'unplaced number discloses' fail-safe the auditor wants. The simpler and safer fix: on telephony, always pass the disclosure sentence (resolveAiDisclosure with tenantEnabled defaulting to true, or call buildAiDisclosureText directly) into buildTelephonyGreeting in all three branches, including a custom tenant greeting. Keep the per-tenant wording override, and have counsel confirm whether any jurisdiction needs a specific placement. Ledger or audit it the same way discloseRecording does. Tests as proposed: a buildTelephonyGreeting unit test per branch, plus handler-level tests asserting the first <Say> or TTS turn contains the AI sentence.

**Auditor's original fix (superseded where the corrected fix differs):**

In bootstrapCallEstablishment (twilio-adapter.ts:1269), resolve the caller's state with the existing `placePhone(from).state` (compliance/us-geography.ts:239), call resolveAiDisclosure({ channel: 'telephony', callerState, businessName, language, customText, tenantEnabled }), and pass the text into buildTelephonyGreeting so it lands after the opener in both the default and persona.greeting branches. Fail safe the same way the recording notice does: an unplaced number discloses. Write an audit or consent-ledger row the same way discloseRecording does. Have counsel confirm the state list; the module itself is flagged 'legal review required'.

**Test specification (from the audit):**

Unit test that buildTelephonyGreeting includes the AI sentence in the default, named-agent and custom-greeting branches. Handler-level tests on TwilioGatherAdapter.handleInbound and the media-streams establishment with a CA (e.g. 415) and an unplaceable caller ID: assert the first <Say> in the TwiML, or the first synthesized TTS turn, contains the AI disclosure and precedes <Start><Record>.

**Acceptance criteria:**

- [ ] A test exists that fails on `origin/main` (or with this finding's fix hunk reverted) for the reason the trigger describes, and passes on the branch.
- [ ] The fix is reached from the trigger's real callers (trace recorded in the PR body), not only from the test.
- [ ] No caller of a changed function regressed; every existing test stays green or its pin is changed with the reason in the commit message.
- [ ] Dead code made dead by this fix is deleted in the same commit.
- [ ] Commit `fix(<area>): <defect in plain words>` names PRIV-4 in the body and ends with the session trailers.

### PRIV-6 — Langfuse content export sends every tenant's prompts and transcripts to a third party behind one global flag, with a regex 'redaction' that lets names, addresses and PANs through and no deprovision purge

- **Severity:** low (auditor said medium). **Verdict:** partial. **Dimension:** privacy.
- **Locations (audit baseline):**
  - `packages/api/src/shared/config.ts:46-58`
  - `packages/api/src/ai/gateway/trace-exporter.ts:146-170`
  - `packages/api/src/ai/gateway/trace-exporter.ts:182`
  - `packages/api/src/ai/gateway/trace-exporter.ts:226-229`
  - `packages/api/src/reputation/pii-redact.ts:107`
  - `packages/api/src/reputation/pii-redact.ts:296`
  - `packages/api/src/app.ts:1497-1499`
  - `packages/api/src/tenants/deprovision.ts:194-245`
  - `packages/api/src/ai/privacy/presidio-adapter.ts:250-270`

**Trigger (the real production path):**

An operator sets LANGFUSE_PUBLIC_KEY/SECRET_KEY and LANGFUSE_CAPTURE_CONTENT=true, for example to debug voice latency. That is one env flag for the whole platform (config.ts:55-58), with the default base URL https://cloud.langfuse.com (config.ts:54). From then on, every gateway completion for every tenant (classify_intent per caller turn, summaries, SMS drafting) exports `redactContentForExport(event.input)` and the reply (trace-exporter.ts:227-228), tagged `tenant:<id>` (182).

**Impact:**

Caller transcripts and CRM context leave the boundary to a subprocessor with no tenant-level opt-in or DPA gate. The 'redaction' is heuristic: names are caught only after a salutation or when the first name is in a 58-name list (pii-redact.ts:107), addresses only as Capitalized-Word + street suffix (296), and PANs, spoken digits and gate/alarm codes not at all. Presidio, the repo's real PII backend, is wired only into training-asset ingestion (app.ts:1441). Tenant deprovision purges Postgres, Twilio and S3, but traces stay at Langfuse indefinitely.

**Evidence:**

I ran redactTextForExport through a throwaway probe (scratchpad/probe/redact-probe.ts) on realistic voice text: 'Customer: Maria Gonzalez, phone +1 (602) 555-0199, 4821 Bridgewater Road' -> 'Customer: Maria Gonzalez, phone [phone], [address], Phoenix AZ'; 'caller: yeah my name is maria gonzalez and i live at forty eight twenty one bridgewater road' -> unchanged; 'caller: my card is 4111 1111 1111 1111 ... cvv 123' -> unchanged; 'caller: the gate code is 4821 and the alarm code is 9930' -> unchanged; 'Known customer: Priya Raman ([email]), 77 elm st apt 4' (name and address kept). config.ts:51 says 'No prod hard-requirement.' deprovision.ts contains no reference to Langfuse or trace deletion.

**Verifier's reasoning (what is real, what was narrowed):**

The code facts check out. LANGFUSE_CAPTURE_CONTENT is a single platform-wide flag (config.ts:55-58) with the base URL defaulting to cloud.langfuse.com. When it is on, buildGenerationBody exports redactContentForExport(input) and redactTextForExport(output), tagged tenant:<id>. Deprovision has no Langfuse cleanup. My own probe matched the auditor's: lowercase spoken names and addresses and spaced PANs pass through unchanged. But the trigger is an operator deliberately opting in, and both defaults are off. Export is a no-op unless both LANGFUSE keys are set, and capture defaults to 'false'. .env.production.example ships the keys empty and capture commented out as false. docs/prod-env-checklist.md says content is 'off by default — voice traces carry caller transcripts'. With capture off, only metadata (tenant id, task type, model, cost, latency) reaches Langfuse, so the deprovision gap matters only when capture is on. This is a hardening gap behind an off-by-default, documented flag, not a live leak. Low severity.

**Fix to implement (verifier's corrected fix):**

The fix is oversized. One config guard is enough: in configSchema's superRefine, reject LANGFUSE_CAPTURE_CONTENT=true when NODE_ENV is production or staging unless LANGFUSE_BASE_URL is a self-hosted (non-cloud.langfuse.com) host, or unless an explicit acknowledgement variable is set, and add a config unit test. Adding the PAN scrubber from PRIV-3 to redactTextForExport comes for free with that change. A per-tenant tenant_settings opt-in, a Presidio fail-closed export path and a Langfuse delete-by-tag in deprovision are optional extras, worth doing only if content capture is actually going to be enabled in production.

**Auditor's original fix (superseded where the corrected fix differs):**

(1) In configSchema (the T4-F06 superRefine pattern), refuse LANGFUSE_CAPTURE_CONTENT=true in production/staging unless PRESIDIO_ANALYZER_URL and PRESIDIO_ANONYMIZER_URL are set. Route exported text through the Presidio anonymizer before the regex pass and fail closed: on PresidioUnavailableError, export metadata only. (2) Add the PAN scrubber from PRIV-3 to redactTextForExport. (3) Gate content per tenant with a tenant_settings opt-in read by the exporter, so content ships only for tenants whose DPA covers the subprocessor. (4) Add a best-effort Langfuse trace delete by `tenant:<id>` tag in deprovisionTenant, beside the S3 object cleanup, or require a self-hosted LANGFUSE_BASE_URL with a retention policy.

**Test specification (from the audit):**

Unit tests in test/ai/gateway/trace-exporter.test.ts with the probe samples above (lowercase spoken name and address, grouped PAN, codes), asserting none survive when a fake Presidio is injected, and that content is dropped (metadata kept) when the fake throws PresidioUnavailableError. Config unit test: NODE_ENV=production with capture=true and no PRESIDIO_* fails validation. Unit test that a tenant without the opt-in gets no input/output on the generation body. Deprovision unit test asserting the trace-delete seam is called with the tenant tag.

**Acceptance criteria:**

- [ ] A test exists that fails on `origin/main` (or with this finding's fix hunk reverted) for the reason the trigger describes, and passes on the branch.
- [ ] The fix is reached from the trigger's real callers (trace recorded in the PR body), not only from the test.
- [ ] No caller of a changed function regressed; every existing test stays green or its pin is changed with the reason in the commit message.
- [ ] Dead code made dead by this fix is deleted in the same commit.
- [ ] Commit `fix(<area>): <defect in plain words>` names PRIV-6 in the body and ends with the session trailers.

## Gate for this batch (every command, exact counts in the PR body)

```
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd packages/api && npm run lint
cd packages/api && npx vitest run                      # full unit suite
cd packages/api && EXTERNAL_TEST_DB_URL=<batch DB> RLS_RUNTIME_ROLE=true \
  npx vitest run --config vitest.integration.config.mts test/integration/<touched and covering files>
npm run check:migration-keys --workspace=packages/api   # when a migration was added
cd packages/api && npx vitest run test/db/migration-immutability.test.ts test/db/migration-key-order.test.ts
```
Plus `packages/shared` / `packages/web` tsc and vitest when touched. Known flake:
`test/settings/voice-approval-pin-route.test.ts:127` (~0.1%); re-run once if it is the only failure.

## Independent review checklist (reviewer runs `code-review`, then this)

- Standards axis: integer cents; UTC; `tenant_id` + RLS; audit event on every mutation; every AI call
  through the gateway; Zod proposals never auto-executed; catalog-grounded prices; entity resolver;
  dead code removed; tests in the same commit; plain owner/caller copy (never AI, agent, dashboard,
  verify, provisioning, proposal, Stripe, Twilio; never a promise the code path can't deliver);
  migrations idempotent, additive, next key, snapshot row.
- Spec axis: each finding ID above, traced from trigger to fix on the production path.
- Adversarial: a test that passes with the fix reverted is BLOCKING; a wrapper, cache-hit, failover
  or background-spawn path that bypasses the fix is BLOCKING; a new security hole is BLOCKING.

## Draft PR body skeleton

```
## Findings closed
- PRIV-3: <one line: mechanism of the fix>
- PRIV-2: <one line: mechanism of the fix>
- PRIV-1: <one line: mechanism of the fix>
- PRIV-4: <one line: mechanism of the fix>
- PRIV-6: <one line: mechanism of the fix>

## Behaviour owners and callers will notice
- <...>

## Plan corrections found during claim verification
- <file:line — what the plan said — what the code says — what was built instead>

## Tests
- <unit / handler / integration files added or changed; each new test fails on main>

## Gate (verbatim summary lines)
- tsc build: <output>
- lint: <output>
- unit: Test Files N passed, Tests N passed
- integration: <files> — Test Files N passed, Tests N passed (RLS_RUNTIME_ROLE=true)

## Owner actions
- <...>

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01LUnuhssW9WEwiZgrAnuvRj
```

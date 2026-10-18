# Wave 1 — Batch E — U5 Live-call reliability

**Branch:** `fix/ai-hardening-voice-reliability`  
**Execution plan:** `docs/plans/2026-10-18-003-chore-ai-hardening-execution-plan.md` (E3 protocol)  
**Technical plan:** `docs/plans/2026-10-18-002-fix-ai-enterprise-hardening-plan.md` unit U5 (PR #1695)  
**Audit baseline:** `origin/main` `20637e004`. Every file:line below is against that commit; re-verify before editing.

## Findings in this batch

| ID | Severity (verified) | Verdict | Title |
|---|---|---|---|
| LCR-04 | high | partial | Telephony webhook failures end the call: /voice, /gather and /dial-result return 503 "so Twilio retries", but Twilio does not retry 5xx and no VoiceFallbackUrl is provisioned; the catch-all paths hang up instead of taking voicemail |
| LCR-05 | high | confirmed | Voice session state is process-local: every voice deploy hangs up calls still live after the 25 s drain, and the documented scale-out (NUM_REPLICAS>1 + REDIS_URL) sends /gather turns and stream upgrades to replicas without the session |
| LCR-01 | high | confirmed | TTS stream failure has no working recovery in production: the buffered fallback always returns mp3 and is discarded, and a failed greeting/disclosure hangs up instead of degrading to Gather |
| LCR-02 | high | confirmed | The silence / low-STT / repeated-failure ladder tells the caller "Let me connect you with a team member" and then hangs up: no notify_oncall, no Dial, no voicemail |
| LCR-03 | high | confirmed | Deepgram `is_final` segments are dispatched as whole caller turns; `speech_final` / UtteranceEnd are ignored, so long utterances split into several LLM turns |
| LCR-06 | medium | confirmed | Per-tenant realtime connection cap (50) hangs up the 51st concurrent caller silently instead of routing to Gather |

## Build order and sequencing

Build order inside the batch, chosen so each step leaves the call path safer than before and
later steps can reuse earlier seams:

1. **LCR-04** first: the DB-free static voicemail TwiML route and the 200-plus-voicemail catch-alls
   are the floor every other failure mode degrades to. The in-memory credential TTL cache and the
   `VoiceFallbackUrl` provisioning plus backfill script land here.
2. **LCR-05** next: `runShutdown` redirect to `/voice/gather-fallback`, the unknown-session `/gather`
   fresh-session path (reuses the LCR-04 route shape), the `NUM_REPLICAS>1` telephony refusal in
   config, and the runbook fix.
3. **LCR-01**: PCM output format on ElevenLabs, `synthesizeBounded` always passing it, greeting
   failure degrading to Gather, post-turn double-failure degrading to Gather.
4. **LCR-02**: the ladder split by cause (pipeline failure or low STT → FSM `system_failure` →
   `notify_oncall` → parked `<Dial>` or no-one-available voicemail; silence → voicemail/`<Record>`/
   callback, never a page). Update the two pinned tests the plan names.
5. **LCR-03**: Deepgram `is_final` buffering, one `final` on `speech_final`/`UtteranceEnd`,
   `utterance_end_ms=1000`, partials forwarded, no final after teardown.
6. **LCR-06** last: per-tenant cap → Gather in `shouldUseRealtimeStream` and `handleStart` (call ids
   set before the cap check).

## File ownership and hot spots

- `packages/api/src/telephony/twilio-adapter.ts`: batch D (privacy) owns `bootstrapCallEstablishment`
  and `buildTelephonyGreeting`; do not edit those two functions. Everything else in the file is yours.
- `packages/api/src/voice/transcription-providers.ts`: you own the Deepgram aggregation; batch D adds
  one `redact=pci` parameter in `buildWsUrl`. Keep your hunks out of the URL parameter list.
- `packages/api/src/shared/config.ts`: one small self-contained hunk in `validateFeatureRequiredConfig`.
- `packages/api/src/app.ts`: wiring only.
- No migration in this batch.

## The unit as ruled in the technical plan (verbatim; this ruling wins)

### U5. Live-call reliability — batch E, `fix/ai-hardening-voice-reliability`

- **Goal:** no dependency failure leaves a caller in silence or hangs up on a promise. Deploys don't
  drop live calls.
- **Requirements:** R1, R2, R5
- **Dependencies:** none
- **Findings:** LCR-01, LCR-02, LCR-03, LCR-04, LCR-05 (high); LCR-06 (medium).
- **Files:**
  - `packages/api/src/ai/tts/tts-provider.ts`
  - `packages/api/src/telephony/media-streams/mediastream-adapter.ts`
  - `packages/api/src/ai/voice-turn/shared/low-stt-ladder.ts`
  - `packages/api/src/telephony/twilio-adapter.ts` — not `bootstrapCallEstablishment` or
    `buildTelephonyGreeting`, which belong to U4
  - `packages/api/src/voice/transcription-providers.ts` (Deepgram aggregation, `utterance_end_ms`)
  - `packages/api/src/routes/telephony.ts`
  - `packages/api/src/integrations/twilio/provisioning.ts`
  - the Twilio webhook credential resolver
  - `packages/api/src/app.ts` `runShutdown`
  - `packages/api/src/shared/config.ts` `validateFeatureRequiredConfig`
  - `docs/runbooks/voice-capacity.md`
  - a new backfill script under `scripts/`
- **Approach:**
  - **LCR-01**
    - Add an opt-in `outputFormat: 'pcm_16000'` on `ElevenLabsTtsProvider.synthesize`, which the
      media-streams `synthesizeBounded` always passes.
    - `failDisclosureClosed` degrades to Gather before closing.
    - After a turn whose stream and PCM recovery both failed, degrade to Gather (`tts_unavailable`).
  - **LCR-02**, split by cause:
    - When the pipeline fails or confidence stays low, dispatch the FSM's `system_failure` through the
      host processor. Its `notify_oncall` then parks a `<Dial>`, or the no-one-available voicemail.
    - When the line is silent, offer voicemail or `<Record>` or a callback. Never page on-call.
    - The terminal copy never promises a transfer that the path can't deliver.
    - Update the pins at `mediastream-adapter.test.ts:2880` and `:3444`.
  - **LCR-03**
    - Buffer `is_final` segments and emit one `final` (joined text, minimum confidence) on
      `speech_final` or `UtteranceEnd`, and add `utterance_end_ms=1000`.
    - Forward the buffered segments as partials, so barge-in and the emergency interim scan still see
      them.
    - Never dispatch a final after teardown.
  - **LCR-04**
    - Provision `VoiceFallbackUrl` (POST) at purchase. Point it at a static, DB-free voicemail TwiML
      route.
    - Keep an in-memory TTL cache of verified webhook credentials, used only when the DB lookup
      throws.
    - The 503 and "try again later" `<Hangup/>` catch-alls on `/voice` and `/gather` become 200 plus
      `buildVoicemailTwiml`.
    - Write an idempotent backfill script for existing numbers that defaults to a dry run. Running it
      is an owner action.
  - **LCR-05**
    - `runShutdown` first redirects live media-streams calls to `/voice/gather-fallback`.
    - An unknown-session `/gather` starts a fresh inbound session, logged as a deploy-induced restart.
    - The config refuses `NUM_REPLICAS>1` on processes that serve telephony.
    - Fix `docs/runbooks/voice-capacity.md:113-115`.
  - **LCR-06**
    - `shouldUseRealtimeStream` returns Gather at the per-tenant cap. This adds the registry to the
      router deps and exports the cap.
    - In `handleStart`, set the call ids before the cap check, then degrade to Gather.
- **Test scenarios:** handler-level, with mocked providers.
  - TTS stream failure → PCM REST recovery plays.
  - Greeting failure → degrades to Gather.
  - Ladder cap after a pipeline failure → Dial or voicemail TwiML.
  - Silence cap → voicemail or callback, with no page.
  - Three `is_final` fragments → one turn.
  - The 51st caller → Gather.
  - Shutdown → live calls redirected.
  - Unknown session → a fresh disclosed session.
  - The config guard.
  - The fallback route returns static TwiML with no DB.
- **Verification:** no test path ends a call right after a "connect you" line.

## Per-finding work packages

Precedence for each finding: the plan ruling above, then the verifier's corrected fix, then the auditor's fix. Trigger, impact, evidence and reasoning are quoted in full from the audit so the implementer and the reviewer trace the same production path.

### LCR-04 — Telephony webhook failures end the call: /voice, /gather and /dial-result return 503 "so Twilio retries", but Twilio does not retry 5xx and no VoiceFallbackUrl is provisioned; the catch-all paths hang up instead of taking voicemail

- **Severity:** high (auditor said high). **Verdict:** partial. **Dimension:** voice.
- **Locations (audit baseline):**
  - `packages/api/src/routes/telephony.ts:451-470`
  - `packages/api/src/routes/telephony.ts:737-756`
  - `packages/api/src/routes/telephony.ts:786-797`
  - `packages/api/src/routes/telephony.ts:578-590`
  - `packages/api/src/routes/telephony.ts:844-853`
  - `packages/api/src/routes/telephony.ts:1475-1483`
  - `packages/api/src/integrations/twilio/provisioning.ts:196-205`

**Trigger (the real production path):**

A Postgres blip or pool exhaustion: pool max 20 with connectionTimeoutMillis 5000 (db/pool.ts:54-56). phoneNumberRepo.findByNumber throws, and resolveInboundTenantId rethrows in prod (telephony.ts:1481-1483). /voice answers `res.status(503)` (469). /gather re-resolves the tenant by DB on EVERY turn, even though the live session already knows it (739-756), so a mid-call blip also 503s. Any throw inside handleGather speaks "We're experiencing technical difficulties. Please try again later." + <Hangup/> (792-797). Separately, Gather turns run with no in-app turn budget: the classify deadline alone is 12 s in prod, against Twilio's ~15 s webhook timeout.

**Impact:**

Twilio's default webhook policy retries only connection timeouts, not 5xx responses. No VoiceFallbackUrl is set on any purchased number, so a 5xx or timeout on /voice plays Twilio's generic "an application error has occurred" and drops the call. Action-URL (/gather, /dial-result) failures drop the call mid-conversation. A brief DB brownout therefore drops every inbound call and every live Gather call, with no voicemail, no lead and no callback, even though a DB-free voicemail TwiML exists (the after-hours branch passes callerPhone/dialedNumber on the callback URL for exactly this no-session case).

**Evidence:**

telephony.ts:460-469: "Respond 5xx so Twilio retries the webhook; do NOT 200-decline" → `res.status(503).type('text/plain').send('Service temporarily unavailable')`. /gather (746-755): "Respond 503 so Twilio retries the webhook rather than the caller losing their turn." provisioning.ts:200-204 purchases with only `PhoneNumber, VoiceUrl, StatusCallback`. A repo-wide grep for VoiceFallbackUrl / voiceFallbackUrl returns nothing.

**Verifier's reasoning (what is real, what was narrowed):**

The outcome is real, but the cited mechanism is not the first failure point, and the fixes as proposed would not take effect. Confirmed: /voice, /gather and /dial-result answer 503 on a tenant-lookup throw (telephony.ts:460-469, 746-755, 786-797 region). The /voice and /gather catch-alls send 'technical difficulties' + <Hangup/>. provisioning.ts:196-205 purchases with only PhoneNumber/VoiceUrl/StatusCallback, and no VoiceFallbackUrl or connection-override retry policy exists anywhere. By Twilio's default policy, 5xx responses are not retried, so a 5xx drops the call with the generic application-error message. The gap in the trigger: every one of these routes sits behind requireTwilioSignature. Its credential resolver (twilio-webhook-credential.ts, createTwilioWebhookCredentialResolver) first runs findByPhoneNumber against tenant_integrations on the same DB. On any DB error it returns outcome 'misconfigured', and the middleware answers 500 (twilio-signature.ts:299-305) before the route runs. In a DB brownout the 500 comes from the middleware in most cases, and the route-level 503 is reached only when the first checkout happens to succeed. Fixes (1) and (2) change code that a DB outage mostly never reaches. Fix (2) also cannot work alone, because even with a known session the resolver's findByTenant path still queries the DB. And a 'DB-free, signature-verified' fallback endpoint is not possible as described: subaccount tenants' tokens live encrypted in that same DB. The side claim of a 12s classify deadline against Twilio's 15s webhook timeout could not be verified.

**Fix to implement (verifier's corrected fix):**

(1) The primary fix is to provision VoiceFallbackUrl (POST) at purchase and backfill existing numbers. Point it at a target that needs neither the API's DB nor its signature resolver: either a Twilio-hosted TwiML Bin/Function, or a static API route serving fixed voicemail TwiML (<Say> + <Record recordingStatusCallback=.../api/telephony/recording?callerPhone&dialedNumber>). Rely on the existing /recording To/From fallback, and let its handler 5xx and be retried later, so ingestion happens once the DB is back. (2) Make the signature layer survive short brownouts: keep an in-memory LRU/TTL cache of verified tenant credentials keyed by DID and subaccount, and use it when the DB lookup throws. Without it, no route-level change runs during an outage. (3) Then, as proposed, replace the 503 and the 'try again later' <Hangup/> catch-alls on /voice and /gather with 200 + buildVoicemailTwiml({callerPhone: From, dialedNumber: To}). On /gather and /dial-result, take the tenant from the in-memory session (keeping sessionBelongsToAnotherTenant) and pass it as tenantId to the credential resolver, which then uses the cache. (4) Correct the misleading 'so Twilio retries' comments.

**Auditor's original fix (superseded where the corrected fix differs):**

(1) Return 200 with `buildVoicemailTwiml({ shopName, recordingStatusCallback: …/voicemail-status, callerPhone: From, dialedNumber: To })`, the shape already used at telephony.ts:539-552, instead of 503 on /voice tenant-lookup failure, and instead of the 'try again later' <Hangup/> in the /voice and /gather catches. (2) On /gather and /dial-result, take the tenant from the in-memory session (`store.get(sid)?.tenantId`, still enforcing sessionBelongsToAnotherTenant) and fall back to the DB lookup only when there is no session. (3) Provision VoiceFallbackUrl (method POST) at purchase, and backfill existing numbers, pointing at a DB-free, signature-verified `/api/telephony/voice/fallback` that returns the same voicemail TwiML.

**Test specification (from the audit):**

Route-level unit tests (supertest, mocked repos). phoneNumberRepo.findByNumber rejects → /voice returns 200 with `<Record`. /gather with the repo rejecting but a live session in the store → the turn proceeds (handleGather called). handleGather throwing → voicemail TwiML, not <Hangup/>. Provisioning unit test asserts VoiceFallbackUrl is in the purchase params.

**Acceptance criteria:**

- [ ] A test exists that fails on `origin/main` (or with this finding's fix hunk reverted) for the reason the trigger describes, and passes on the branch.
- [ ] The fix is reached from the trigger's real callers (trace recorded in the PR body), not only from the test.
- [ ] No caller of a changed function regressed; every existing test stays green or its pin is changed with the reason in the commit message.
- [ ] Dead code made dead by this fix is deleted in the same commit.
- [ ] Commit `fix(<area>): <defect in plain words>` names LCR-04 in the body and ends with the session trailers.

### LCR-05 — Voice session state is process-local: every voice deploy hangs up calls still live after the 25 s drain, and the documented scale-out (NUM_REPLICAS>1 + REDIS_URL) sends /gather turns and stream upgrades to replicas without the session

- **Severity:** high (auditor said high). **Verdict:** confirmed. **Dimension:** voice.
- **Locations (audit baseline):**
  - `packages/api/src/ai/agents/customer-calling/voice-session-store.ts:526`
  - `packages/api/src/app.ts:7842-7860`
  - `packages/api/src/telephony/media-streams/twilio-mediastream-server.ts:147-153`
  - `packages/api/src/telephony/twilio-adapter.ts:2279-2289`
  - `packages/api/src/shared/config.ts:635-644`
  - `docs/runbooks/voice-capacity.md:113-115`

**Trigger (the real production path):**

(a) Any deploy of the service that carries telephony. runShutdown waits only `DRAIN_TIMEOUT_MS || 25_000` for liveCount() to reach 0 (app.ts:7842-7845), then tears down. Twilio ends realtime calls because nothing follows </Connect>. A Gather call's next /gather reaches the new process, where `store.get` misses (twilio-adapter.ts:2279-2289) → "I'm sorry, your session has ended. Please call again." + hang-up. (b) Following the scale-out guidance: railway.toml / config.ts:635-644 require only REDIS_URL for NUM_REPLICAS>1, and voice-capacity.md:114 says "Each instance is independent". With 2 replicas, the Twilio WS upgrade and each /gather POST are separate HTTP requests that Railway load-balances, so on the other replica findByCallSid misses → rejectUpgrade 403 (twilio-mediastream-server.ts:149-152), or the /gather session-ended hang-up.

**Impact:**

Contractual uptime cannot be met. Every release that touches the voice process drops in-flight calls; the code knows this and only alarms ('emitDrainAbandonment … teardown below hangs up on real callers'). Scaling out, which an enterprise tenant base needs, would drop a large share of calls at stream connect or on every Gather turn, and nothing at boot blocks that configuration.

**Evidence:**

voice-session-store.ts:526 `private readonly sessions = new Map<string, VoiceSession>();`. There is no rehydration anywhere (grep for rehydrat/restoreSession: none). app.ts:7847-7850: "WS15 — drain-abandonment alarm: the window expired with live calls remaining, so teardown below hangs up on real callers (Twilio ends them)." config.ts:636 `if (Number.isFinite(numReplicas) && numReplicas > 1 && !env.REDIS_URL)` is the only multi-replica guard. The Redis fan-out mirrors events only: scaling.md says "a live VoiceSession stays in-process on the replica Twilio pinned the media-stream to". The architecture regrade notes "no mid-call replica handoff" as a remaining gap.

**Verifier's reasoning (what is real, what was narrowed):**

VoiceSessionStore holds sessions in a private Map (voice-session-store.ts:526), and grep finds no rehydration path. runShutdown (app.ts:7842-7860) polls liveCount() for DRAIN_TIMEOUT_MS || 25_000, then tears down. When calls are still live it only raises the alarm (emitDrainAbandonment). Realtime calls end there because nothing follows </Connect>. Gather is hit sooner than the finding says. With overlapSeconds = 35 (railway.toml / railway.voice.toml), Railway sends new requests to the new deployment as soon as it is healthy. So a live Gather call's next /gather lands on a process where store.get misses (twilio-adapter.ts:2279-2289) → session_ended_call_again + end_session. That happens at cutover, not only after the 25s drain. The scale-out half is real but latent: numReplicas = 1 in both toml files. The only multi-replica guard is the REDIS_URL check (config.ts:636), and voice-capacity.md:113-115 says 'Each instance is independent'. With more than one replica, a WS upgrade or /gather on a replica without the session fails (twilio-mediastream-server.ts:147-153 rejectUpgrade 403; same /gather miss). scaling.md:135 itself says the VoiceSession stays in-process.

**Fix to implement (verifier's corrected fix):**

Mostly as proposed. (1) At the start of runShutdown, before the drain loop, redirect every live media-streams CallSid through twilioCallRedirector to /voice/gather-fallback. The redirected request reaches the new deployment, which treats the unknown CallSid as a fresh Gather session and gives a disclosed greeting. (2) In the _handleGatherLocked unknown-session branch, start a fresh inbound session from From/To (with the tenant resolved by DID, as /voice does) instead of hanging up. Note that this replays the greeting and disclosure and loses FSM context, so log it as a deploy-induced restart. (3) Make validateFeatureRequiredConfig refuse NUM_REPLICAS>1 on any process that serves telephony until session state is externalized or call affinity exists, and fix voice-capacity.md:113-115. The tests as proposed fit.

**Auditor's original fix (superseded where the corrected fix differs):**

Minimal, in the repo's idiom: (1) At the start of runShutdown, REST-redirect every live media-streams call (the twilioCallRedirector already used by WS7) to /voice/gather-fallback. With overlapSeconds = 35 the request lands on the new replica, where an unknown CallSid starts a fresh disclosed Gather session instead of being hung up. (2) In the _handleGatherLocked unknown-session branch, start a fresh inbound session (handleInbound with From/To) rather than 'Please call again' + hang-up. (3) Until session state is externalized or replica affinity exists, make the config guard refuse NUM_REPLICAS>1 on any process serving telephony (PROCESS_ROLE web or voice), and correct voice-capacity.md:113-115.

**Test specification (from the audit):**

Unit: a shutdown test with a fake store (liveCount>0, liveCallSids) and a spy redirector asserts one redirect per live CallSid before teardown. Gather unit: an unknown sid with From/To returns greeting/disclosure TwiML, not <Hangup/>. Config unit: NUM_REPLICAS=2 with PROCESS_ROLE=voice and REDIS_URL set fails validateFeatureRequiredConfig.

**Acceptance criteria:**

- [ ] A test exists that fails on `origin/main` (or with this finding's fix hunk reverted) for the reason the trigger describes, and passes on the branch.
- [ ] The fix is reached from the trigger's real callers (trace recorded in the PR body), not only from the test.
- [ ] No caller of a changed function regressed; every existing test stays green or its pin is changed with the reason in the commit message.
- [ ] Dead code made dead by this fix is deleted in the same commit.
- [ ] Commit `fix(<area>): <defect in plain words>` names LCR-05 in the body and ends with the session trailers.

### LCR-01 — TTS stream failure has no working recovery in production: the buffered fallback always returns mp3 and is discarded, and a failed greeting/disclosure hangs up instead of degrading to Gather

- **Severity:** high (auditor said critical). **Verdict:** confirmed. **Dimension:** voice.
- **Locations (audit baseline):**
  - `packages/api/src/ai/tts/tts-provider.ts:172-202`
  - `packages/api/src/ai/tts/tts-provider.ts:218`
  - `packages/api/src/telephony/media-streams/mediastream-adapter.ts:3200-3218`
  - `packages/api/src/telephony/media-streams/mediastream-adapter.ts:3338-3381`
  - `packages/api/src/telephony/media-streams/mediastream-adapter.ts:1532-1545`
  - `packages/api/src/telephony/media-streams/mediastream-adapter.ts:1645-1666`
  - `packages/api/src/telephony/twilio-adapter.ts:1360`
  - `packages/api/src/routes/telephony.ts:653-662`

**Trigger (the real production path):**

An ElevenLabs streaming WebSocket blip or stall. A stall is cut at ELEVENLABS_STREAM_INACTIVITY_MS = 4_000 (elevenlabs-stream.ts:20). Path: runTurnWithFiller → ttsProvider.synthesizeStream throws (mediastream-adapter.ts:3200) → recoverTurnAfterStreamFailure → synthesizeBounded → ElevenLabsTtsProvider.synthesize (tts-provider.ts:166). That method always sends `Accept: 'audio/mpeg'` and returns `contentType: 'audio/mpeg'`, so the guard at mediastream-adapter.ts:3358-3381 drops the result and at most a filler clip plays. On the greeting turn, handleStart sees disclosureTurnComplete !== true (1533) and calls failDisclosureClosed. That method only does `this.closeWs(1011, 'disclosure_init_failed')` (1665). Nothing follows `</Connect>` in buildStreamTwiML (twilio-adapter.ts:1603-1612), so Twilio hangs up. Production must use ElevenLabs, because assertTtsProviderSupportsMediaStreams requires synthesizeStream.

**Impact:**

During a TTS vendor incident, every new realtime call hears a filler ("one moment"), up to ~6 s of dead air spent on a REST synth that is thrown away, and then a disconnect. The realtime circuit trips only after 2 failures per process and half-opens every 60 s (realtime-health-circuit.ts), so drops recur. Calls already in progress go mute: every reply becomes filler-only, the caller never hears the answers, and mid-call TTS failures never vote the circuit. The hang-up happens even though /voice/gather-fallback is built to speak the disclosure on an undisclosed degrade and voices it with Twilio <Say>, which does not depend on ElevenLabs.

**Evidence:**

tts-provider.ts:179 `Accept: 'audio/mpeg'` / :200 `contentType: 'audio/mpeg'`, while the same class's probe already uses `?output_format=pcm_16000` (:218). filler-audio-cache.ts:20: "(`synthesize()` returns mp3, which the media path cannot play)". mediastream-adapter.ts:3376-3379: `'mediastream: buffered TTS fallback returned non-PCM audio, cannot stream — trying filler'`. The Deepgram-open failure degrades: `if (!(await this.attemptDegradeToGather('deepgram_open_failed'))) { this.closeWs(1011, ...) }` (1501-1503). failDisclosureClosed never attempts a degrade (1659-1665). twilio-adapter.ts:1360 latches `session.recordingDisclosed = true` before playback, so a naive degrade would also skip the disclosure in buildDegradeFallbackTwiml (routes/telephony.ts:1241). The VOX-35b unit tests mock the buffered synth as `contentType: 'audio/pcm'` (test/telephony/media-streams/mediastream-adapter.test.ts:1369, 2785), which production never returns.

**Verifier's reasoning (what is real, what was narrowed):**

I checked each step in the code and it holds. ElevenLabsTtsProvider.synthesize (tts-provider.ts:172-202) always sends Accept: audio/mpeg and returns contentType 'audio/mpeg'. The same class's probe already uses ?output_format=pcm_16000 (:218). recoverTurnAfterStreamFailure (mediastream-adapter.ts:3338-3381) drops any non-PCM result through isRawPcmContentType, and the comment above it says ElevenLabs REST returns mp3. So in production the buffered recovery can never play, and at most a filler clip plays (2 attempts x DEFAULT_TTS_ATTEMPT_TIMEOUT_MS of 3s, after the 4s ELEVENLABS_STREAM_INACTIVITY_MS stall). The boot guard (app.ts:4596) forces a synthesizeStream provider, so production is ElevenLabs. On the greeting turn, disclosureTurnComplete is copied from turnRealAudioComplete (2815-2816), and the filler path never sets that flag, so handleStart calls failDisclosureClosed (1543). That method only records a circuit failure, writes an audit and runs closeWs(1011) (1659-1665). It never tries attemptDegradeToGather, unlike the Deepgram-open failure branch (1501-1503). buildStreamTwiML has nothing after </Connect>, so Twilio ends the call. bootstrapCallEstablishment sets session.recordingDisclosed = true (twilio-adapter.ts:1360) before playback, so a naive degrade would skip the disclosure in buildDegradeFallbackTwiml (telephony.ts:1241). The mid-call path only records the 'tts_stream_recovered' voice error and never votes the circuit. restRedirect and fillerCache are both wired in production (app.ts:4836, 4875-4876). I lowered severity from critical to high. Once 2 failures trip the process-wide RealtimeHealthCircuit, new calls go to Gather (Twilio <Say>) for 60s, so in a sustained outage only the calls admitted in each half-open window are dropped. A transient blip on a non-greeting turn costs one turn (filler, then listening again), not the call. The real damage is: greeting-turn blips hang up undisclosed callers, and calls in progress go mute during an outage.

**Fix to implement (verifier's corrected fix):**

(1) As proposed, add an opt-in outputFormat 'pcm_16000' to TtsSynthesizeInput. ElevenLabsTtsProvider.synthesize then calls ...?output_format=pcm_16000, omits the Accept header and returns 'audio/pcm'. synthesizeBounded in the media-streams adapter always passes it. Leave the default mp3 behavior alone for other synthesize() callers (readback, filler synthesis). (2) In failDisclosureClosed: set session.recordingDisclosed = false (captureEnabled is still false), then `if (await this.attemptDegradeToGather('disclosure_init_failed')) return;`, and only then closeWs(1011). Keep the circuit vote and audit. (3) Do more than vote the circuit for mid-call failures: after a turn whose stream and PCM-REST recovery both failed (or after 2 consecutive tts_stream_recovered turns), vote failure and call attemptDegradeToGather('tts_unavailable'), so the call continues on Twilio <Say> instead of staying filler-only. A PCM REST fallback cannot help when the vendor itself is down.

**Auditor's original fix (superseded where the corrected fix differs):**

(1) Add an optional `outputFormat?: 'pcm_16000'` to TtsSynthesizeInput. When it is set, ElevenLabsTtsProvider.synthesize posts to `…/text-to-speech/${voiceId}?output_format=pcm_16000` (the probe's URL) and returns `contentType: 'audio/pcm'`. synthesizeBounded in mediastream-adapter.ts passes it. (2) In failDisclosureClosed, set `session.recordingDisclosed = false` and try `attemptDegradeToGather('disclosure_init_failed')` before `closeWs(1011)`. captureEnabled stays false, so nothing is captured on the stream leg, and gather-fallback speaks `disclose.two_party` in a standalone <Say> before <Gather>. (3) Optionally vote the realtime circuit on repeated mid-call `tts_stream_recovered` failures.

**Test specification (from the audit):**

Unit (tts-provider): with a mocked fetch, synthesize({outputFormat:'pcm_16000'}) requests `output_format=pcm_16000` and returns 'audio/pcm'. Handler-level (mediastream-adapter.test.ts): use a TTS whose synthesizeStream throws and whose synthesize returns mp3 unless PCM is requested. Assert the greeting PCM streams and capture opens. Second case, TTS fully dead: assert restRedirect is called, closeReason is 'degraded_to_gather' and session.recordingDisclosed === false. Route unit test: gather-fallback for that session emits the disclosure <Say> before <Gather>.

**Acceptance criteria:**

- [ ] A test exists that fails on `origin/main` (or with this finding's fix hunk reverted) for the reason the trigger describes, and passes on the branch.
- [ ] The fix is reached from the trigger's real callers (trace recorded in the PR body), not only from the test.
- [ ] No caller of a changed function regressed; every existing test stays green or its pin is changed with the reason in the commit message.
- [ ] Dead code made dead by this fix is deleted in the same commit.
- [ ] Commit `fix(<area>): <defect in plain words>` names LCR-01 in the body and ends with the session trailers.

### LCR-02 — The silence / low-STT / repeated-failure ladder tells the caller "Let me connect you with a team member" and then hangs up: no notify_oncall, no Dial, no voicemail

- **Severity:** high (auditor said high). **Verdict:** confirmed. **Dimension:** voice.
- **Locations (audit baseline):**
  - `packages/api/src/ai/voice-turn/shared/low-stt-ladder.ts:63`
  - `packages/api/src/ai/voice-turn/shared/low-stt-ladder.ts:81-95`
  - `packages/api/src/telephony/media-streams/mediastream-adapter.ts:2261-2274`
  - `packages/api/src/telephony/media-streams/mediastream-adapter.ts:2300-2311`
  - `packages/api/src/telephony/media-streams/mediastream-adapter.ts:2340-2367`
  - `packages/api/src/telephony/twilio-adapter.ts:3039-3058`
  - `packages/api/src/ai/agents/customer-calling/tts-copy.ts:155-157`

**Trigger (the real production path):**

A caller is silent for 8 s twice after an agent turn, for example while finding an account number. Path: the silence-arm mark ack → armSilenceRepromptTimer (mediastream-adapter.ts:3754) → recoverFromSilenceExpiry (2340) → recoverFromLowSttConfidence (2300). Strike 2 hits MAX_CONSECUTIVE_LOW_CONFIDENCE_TURNS = 2 → speakAndEndAfterRepeatedSpeechTurnFailures (2261) → handleClose('end_session') → closeWs(1000), and Twilio ends the call. The same ending fires on two consecutive Deepgram finals below VOICE_MIN_STT_CONFIDENCE (a noisy line, 1939-1941) and on two consecutive speechTurn throws (VOX-35c, 2213-2220). On Gather, two empty SpeechResults reach runLowSttConfidenceGatherLadder (twilio-adapter.ts:2376-2377 → 3039), which returns the copy plus end_session, i.e. <Hangup/>.

**Impact:**

A very common, non-failure caller behaviour ends the call after the caller has been promised a person. No human is paged in real time. The only follow-up is a dropped-call SMS to the caller about 60 s later (RECOVERY_OUTCOMES 'failed'), and only if caller ID is usable. The FSM's own system_failure path does page on-call and bridge (transitions.ts:403-419), so these adapter-level endings skip the escalation path the copy describes. Leads and urgent jobs are lost. For an enterprise contact-handling SLA this is a blocker.

**Evidence:**

low-stt-ladder.ts:81-95: `streak >= MAX_CONSECUTIVE_LOW_CONFIDENCE_TURNS ? { escalate: true, copy: SPEECH_TURN_FAILURE_ESCALATION_COPY, ...}` and `if (step.escalate) { effects.push({ type: 'end_session', payload: { reason: LOW_STT_LADDER_TERMINAL_REASON } }) }`. There is no notify_oncall effect. tts-copy.ts:156: "I'm having trouble completing that. Let me connect you with a team member." mediastream-adapter.ts:2265-2273: `await this.speakRecoveryLine(session, SPEECH_TURN_FAILURE_ESCALATION_COPY); … this.handleClose('end_session');`. The existing tests pin the hang-up: mediastream-adapter.test.ts:3444-3475 ('a second consecutive silence expiry escalates and ends the session' → `expect(ws.closed).toBe(true)`) and :2880-2925. Both were run and pass.

**Verifier's reasoning (what is real, what was narrowed):**

The code matches the claim. lowSttLadderStep (low-stt-ladder.ts:82-86) escalates at MAX_CONSECUTIVE_LOW_CONFIDENCE_TURNS = 2 with SPEECH_TURN_FAILURE_ESCALATION_COPY, which reads "I'm having trouble completing that. Let me connect you with a team member." (tts-copy.ts:155-157). lowSttLadderEffects adds only end_session, never notify_oncall. On media streams, recoverFromLowSttConfidence (2300-2318), recoverFromSilenceExpiry (2340-2367, reached from the 8s DEFAULT_SILENCE_REPROMPT_MS timer at 3754) and VOX-35c recoverFromSpeechTurnFailure (2213-2230) all reach speakAndEndAfterRepeatedSpeechTurnFailures (2261-2274). That method speaks the line, stashes a synthetic end_session and calls handleClose('end_session'). Nothing dispatches to the FSM, so nothing parks a <Dial>. On Gather, an empty SpeechResult (twilio-adapter.ts:2376-2377) or a low Confidence reaches runLowSttConfidenceGatherLadder (3039-3058). It renders the effects through finalizeTwiml, which ends the session and hangs up. By contrast, the FSM's system_failure transition (transitions.ts:403-419) emits notify_oncall. The test at mediastream-adapter.test.ts:3444 pins the hang-up. Two things soften the impact: the 'failed' outcome triggers the dropped-call recovery SMS, and any caller speech, even interim, resets the silence timer. So 'very common' overstates the silent-caller case. Noisy lines and a broken turn pipeline are realistic triggers, and the copy promising a transfer that never happens is a real defect.

**Fix to implement (verifier's corrected fix):**

Split by cause. (a) VOX-35c pipeline failures and low-confidence caps, where the caller is speaking but we can't serve them: dispatch the FSM's system_failure (reason LOW_STT_LADDER_TERMINAL_REASON or speech_turn_repeated_failure) and deliver it through the host processor (deliverEscalationEffects + maybeHandOffToHuman on media streams; executeSideEffects + finalizeTwiml on Gather). notify_oncall then parks the <Dial>, or the no-one-available voicemail. End the leg only if nothing was parked. (b) Pure-silence caps, where nobody may be on the line: don't page on-call, because pocket dials and dead lines would flood staff. Instead play voicemail/<Record>, or a closing line that offers a callback. (c) In every case, change the terminal copy so it never promises a transfer that the code path cannot deliver. Update the pins at mediastream-adapter.test.ts:2880 and :3444.

**Auditor's original fix (superseded where the corrected fix differs):**

At the ladder cap (shared ladder, both transports) and at the VOX-35c cap, run the FSM's real escalation, `session.machine.dispatch({ type: 'system_failure', reason: LOW_STT_LADDER_TERMINAL_REASON })` or a dedicated event, through the host processor: deps.deliverEscalationEffects on media streams, processor.executeSideEffects plus finalizeTwiml on Gather. notify_oncall then parks the <Dial> or the no-one-available voicemail TwiML, and media streams delivers it with maybeHandOffToHuman('ladder_cap'). End the leg only if nothing was parked, and then with copy that offers voicemail or a callback instead of promising a transfer.

**Test specification (from the audit):**

Handler-level unit tests with mocked deps. Media streams: two silence expiries with takePendingTransferTwiml returning a <Dial> → restRedirect is called with that TwiML and the WS is not closed by the ladder. Gather: runLowSttConfidenceGatherLadder at the cap returns TwiML containing <Dial (or <Record> when no one is on call). Update the pins at mediastream-adapter.test.ts:2880 and :3444.

**Acceptance criteria:**

- [ ] A test exists that fails on `origin/main` (or with this finding's fix hunk reverted) for the reason the trigger describes, and passes on the branch.
- [ ] The fix is reached from the trigger's real callers (trace recorded in the PR body), not only from the test.
- [ ] No caller of a changed function regressed; every existing test stays green or its pin is changed with the reason in the commit message.
- [ ] Dead code made dead by this fix is deleted in the same commit.
- [ ] Commit `fix(<area>): <defect in plain words>` names LCR-02 in the body and ends with the session trailers.

### LCR-03 — Deepgram `is_final` segments are dispatched as whole caller turns; `speech_final` / UtteranceEnd are ignored, so long utterances split into several LLM turns

- **Severity:** high (auditor said high). **Verdict:** confirmed. **Dimension:** voice.
- **Locations (audit baseline):**
  - `packages/api/src/voice/transcription-providers.ts:480-484`
  - `packages/api/src/voice/transcription-providers.ts:588-603`
  - `packages/api/src/telephony/media-streams/mediastream-adapter.ts:1892-1907`
  - `packages/api/src/telephony/media-streams/mediastream-adapter.ts:1976-1983`

**Trigger (the real production path):**

A caller speaks one long sentence with no pause, for example describing the problem and the address. Deepgram (opened with `interim_results=true…&endpointing=600`) finalizes the segment with `is_final:true, speech_final:false` mid-utterance and sends `speech_final:true` only at the endpoint. DeepgramStreamingProvider maps every `is_final` to `type: 'final'` (transcription-providers.ts:599). onTranscriptEvent then treats each final as a complete turn: low-STT gate, filler, hold line, then `withSessionLock(... this.deps.speechTurn(...))` (mediastream-adapter.ts:1976-1983) → twilioAdapter.processCallerUtterance → processor.speechTurn → classifyIntent.

**Impact:**

One utterance becomes two or more FSM turns. The first half is classified on its own: the FSM advances, a readback or reprompt starts while the caller is still talking and is barged in, and then the second half is handled as an answer to a prompt the caller never heard. Each fragment costs a full classify (~9k input tokens, up to the 12 s deadline), which uses up the 72k-token session cap and brings cost_cap_exceeded escalations sooner. It also feeds the repeated-intent and low-confidence counters, and the one-shot language detection runs on a fragment. The production phone transport is affected (realtime is default ON).

**Evidence:**

transcription-providers.ts:593-602: the parsed type is `{ type?; channel?; is_final?: boolean }`, with no speech_final, and `onEvent({ type: data.is_final ? 'final' : 'partial', … isFinal: data.is_final ?? false })`. No `utterance_end_ms` is requested (:484). The repo's own web client accumulates finals until the endpoint: packages/web/src/hooks/useDeepgramDictation.ts:287-296 `if (d.is_final) { finalsRef.current.push(transcript); … if (continuousRef.current && d.speech_final) { flushUtterance(); …` with the comment "UtteranceEnd is the fallback for finals that arrive without it". It has a test 'flushes accumulated finals on a Deepgram UtteranceEnd event (finals without speech_final)'. No `speech_final` handling exists anywhere in packages/api.

**Verifier's reasoning (what is real, what was narrowed):**

DeepgramStreamingProvider.openSession (transcription-providers.ts:588-603) parses only {type, channel, is_final}. It emits type 'final' for every is_final:true Results frame and ignores speech_final. The URL (480-484) sets interim_results=true and endpointing=600 but no utterance_end_ms. grep finds no speech_final or UtteranceEnd handling anywhere in packages/api or packages/shared. app.ts:4601/4831 passes the raw provider straight to the adapter, with no aggregating wrapper. onTranscriptEvent (1873-1983) treats each isFinal event as a full turn: low-STT gate, filler, hold line, then withSessionLock(speechTurn). Deepgram documents that with interim_results it finalizes segments (is_final:true, speech_final:false) during long continuous speech, and recommends concatenating is_final segments until speech_final or UtteranceEnd. The repo's web client (useDeepgramDictation.ts) already does this. A long caller description is therefore split across several FSM/LLM turns on the default realtime transport. The fragments queue behind the session lock, and the first fragment's reply is barged in by the caller's continuing interims.

**Fix to implement (verifier's corrected fix):**

The auditor's fix is right. Buffer is_final segments inside the provider and emit one 'final' (joined text, minimum confidence) on speech_final:true, or on an UtteranceEnd message (add &utterance_end_ms=1000; this requires interim_results=true, which is already set). Meanwhile forward each buffered segment as a 'partial' so barge-in, latchLifeSafety and the RV-140 interim emergency scan still see it. On finish(), discard the buffer or flush it before close, so a final is never dispatched after the leg has torn down. Add the unit tests and the handler-level test as proposed.

**Auditor's original fix (superseded where the corrected fix differs):**

In DeepgramStreamingProvider.openSession, buffer `is_final` transcripts and emit ONE `final` event (joined text, minimum confidence) on `speech_final: true`, or on a Deepgram `UtteranceEnd` message (add `&utterance_end_ms=1000` to buildWsUrl). Forward the buffered `is_final` text as `partial` events in the meantime, so barge-in and the RV-140 interim emergency scan still see it. Flush any buffer in finish(). This mirrors useDeepgramDictation.

**Test specification (from the audit):**

Unit (test/voice/transcription-providers): drive a fake WebSocket with [is_final:true, speech_final:false 'my furnace stopped'] then [is_final:true, speech_final:true 'at 42 Elm Street'] → exactly one 'final' event with the concatenated transcript. Separate case: UtteranceEnd flushes a final-only buffer. Handler-level (mediastream-adapter.test.ts): the same frame sequence results in speechTurn called once.

**Acceptance criteria:**

- [ ] A test exists that fails on `origin/main` (or with this finding's fix hunk reverted) for the reason the trigger describes, and passes on the branch.
- [ ] The fix is reached from the trigger's real callers (trace recorded in the PR body), not only from the test.
- [ ] No caller of a changed function regressed; every existing test stays green or its pin is changed with the reason in the commit message.
- [ ] Dead code made dead by this fix is deleted in the same commit.
- [ ] Commit `fix(<area>): <defect in plain words>` names LCR-03 in the body and ends with the session trailers.

### LCR-06 — Per-tenant realtime connection cap (50) hangs up the 51st concurrent caller silently instead of routing to Gather

- **Severity:** medium (auditor said medium). **Verdict:** confirmed. **Dimension:** voice.
- **Locations (audit baseline):**
  - `packages/api/src/telephony/media-streams/mediastream-adapter.ts:1368-1386`
  - `packages/api/src/ws/connection-registry.ts:27`
  - `packages/api/src/routes/telephony.ts:1290-1365`

**Trigger (the real production path):**

A tenant has 50 concurrent realtime calls, for example a multi-location enterprise tenant during a heat wave or storm. /voice → shouldUseRealtimeStream (telephony.ts:1290) checks prerequisites, TTS health, the circuit and the tenant flag, but not the connection cap, so it returns <Connect><Stream>. On the WS `start` frame, registry.acquire returns null (perTenantMax: 50) → `this.closeWs(1013, 'tenant_connection_cap')` (mediastream-adapter.ts:1384). That runs before state.callSid is set, so attemptDegradeToGather cannot run. The stream closes and Twilio ends the call.

**Impact:**

Overflow callers hear silence and are disconnected, with no greeting, voicemail or Gather fallback, exactly at peak demand, when lost calls cost the most. The cap is a safety limit, so overflow should degrade rather than drop.

**Evidence:**

mediastream-adapter.ts:1379-1385: `if (!lease) { this.logSecurityEvent('tenant_connection_cap_exceeded', …); this.closeWs(1013, 'tenant_connection_cap'); return; }`. `this.state.callSid = callSid` is only assigned at 1391, after this return, and attemptDegradeToGather bails on `!callSid` (1768). connection-registry.ts:27 `perTenantMax: 50`. shouldUseRealtimeStream has no registry check.

**Verifier's reasoning (what is real, what was narrowed):**

handleStart calls registry.acquire (mediastream-adapter.ts:1373-1386), and when it returns null it runs closeWs(1013, 'tenant_connection_cap') and returns. That happens before this.state.callSid and accountSid are assigned (1391-1392). attemptDegradeToGather bails on !callSid (1768), so it could not run here even if it were called. DEFAULT_REGISTRY_CONFIG.perTenantMax = 50 (connection-registry.ts:27), and createConnectionRegistry is called with the default config (app.ts:870). shouldUseRealtimeStream (telephony.ts:1290-1365) checks prerequisites, the TTS credential verdict, the circuit and the tenant flag, but not the registry. The router deps have no connectionRegistry at all. <Connect><Stream> speaks nothing and nothing follows </Connect>, so the 51st concurrent caller gets silence and then a disconnect. Medium fits: 50 concurrent realtime calls per tenant is rare for this customer base, but when it happens the result is a silent drop at peak load.

**Fix to implement (verifier's corrected fix):**

As proposed, with wiring. Add the connection registry (or a count probe) to TelephonyRouterDeps. In shouldUseRealtimeStream, return false (Gather) when count('twilio_media_streams', tenantId) >= perTenantMax; this requires exporting the cap. As a backstop for the check-then-acquire race in handleStart, set state.callSid/accountSid/session before the cap check, then call attemptDegradeToGather('tenant_connection_cap') and fall back to closeWs(1013) only if the redirect fails.

**Auditor's original fix (superseded where the corrected fix differs):**

In shouldUseRealtimeStream, read `connectionRegistry.count('twilio_media_streams', tenantId)` and return false (Gather) at or above perTenantMax. As a backstop in handleStart, set state.callSid/accountSid before the cap check and call `attemptDegradeToGather('tenant_connection_cap')` before closeWs(1013).

**Test specification (from the audit):**

Adapter unit test: registry.acquire resolves null and restRedirect is a spy → restRedirect is called with the CallSid and closeReason is 'degraded_to_gather'. Route unit test: a registry whose count is at max → /voice returns Gather TwiML, not <Stream>.

**Acceptance criteria:**

- [ ] A test exists that fails on `origin/main` (or with this finding's fix hunk reverted) for the reason the trigger describes, and passes on the branch.
- [ ] The fix is reached from the trigger's real callers (trace recorded in the PR body), not only from the test.
- [ ] No caller of a changed function regressed; every existing test stays green or its pin is changed with the reason in the commit message.
- [ ] Dead code made dead by this fix is deleted in the same commit.
- [ ] Commit `fix(<area>): <defect in plain words>` names LCR-06 in the body and ends with the session trailers.

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
- LCR-04: <one line: mechanism of the fix>
- LCR-05: <one line: mechanism of the fix>
- LCR-01: <one line: mechanism of the fix>
- LCR-02: <one line: mechanism of the fix>
- LCR-03: <one line: mechanism of the fix>
- LCR-06: <one line: mechanism of the fix>

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

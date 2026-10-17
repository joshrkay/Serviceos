# C — How the phone agent decides what to say (knowledge base + persona design)

All paths relative to `packages/api/src/` unless noted. Branch `plan/voice-parity-bland-avoca`.

## 1. Classifier prompt assembly (`caller` profile, inbound call)

**Call site.** `ai/voice-turn/create-voice-turn-processor.ts:1372-1407` `buildPhoneClassifyContext` builds a `ClassifyContext` (`ai/orchestration/intent-classifier.ts:1108-1234`); profile comes from session identity only: `classifierProfileForSession` (:643-647) → `'owner_line'` | `'operator'` (in-app) | `'field_tech'` (D-026 actor) | `'caller'`.

**Assembly** happens in `classifyIntentRaw` (`intent-classifier.ts:3116-3212`) as an ordered array of **separate system messages**, then one user message. Measured 2026-10-16 with `npx tsx` (chars/4):

| # | Block | Source | Tokens | Varies by |
|---|---|---|---|---|
| 1 | Base taxonomy prompt (memoized per profile) | `classifier-profile.ts:285-326` → pieces in `intent-taxonomy-blocks.ts` | **~3,050** (12,195 chars) | static |
| 1a | `CALLER_PREAMBLE_HEAD` ("inbound customer caller") | `intent-taxonomy-blocks.ts:41` | | static |
| 1b | `CALLER_MONEY_PREAMBLE` (money/doc asks → `operator_request`) | `:848` | | static |
| 1c | `INTENT_LIST_HEADER` + one block per intent in `INTENT_BLOCK_ORDER` filtered by `PROFILE_INTENTS.caller`, caller variants for `create_customer`/`lookup_jobs`/`lookup_account_summary` (`:875-915`) + `TRAILING_UNKNOWN_BLOCK` | | static |
| 1d | `DISTINCTIONS_HEADER` + rules where *every* contrasted intent is advertised (`:954-1010`) — for caller, none survive | | static |
| 1e | `SCHEMA_HEAD` + `ENTITY_FIELDS` filtered to advertised intents (15 lines survive) + `SCHEMA_TAIL` + `CALIBRATION` | `:1013-1104` | | static |
| 2 | "Tenant vertical context (use ONLY for entity recognition…)" = `formatVerticalForCallerPrompt` + `formatIntakeQuestionsForPrompt` + `formatObjectionScriptsForPrompt` + `buildTrainingAssetPromptSection` (≤5 assets, ≤1000 chars each) | `verticals/resolve-active-pack.ts:103-213`, `verticals/context-assembly.ts:153-252`, `verticals/training-assets.ts:126-150` | HVAC pack ≈ **833** (453+95+285); up to ~1.5k more with training assets | per-tenant (5-min LRU cache) |
| 3 | "Caller plan context" (`formatCallerPlanForPrompt`) | `ai/orchestration/caller-plan-context.ts:77-93` | ~60 | per-call (customerId) |
| 4 | "Caller account context" (B2B) | `ai/agents/customer-calling/b2b-account-context.ts:313-340` | ~80 | per-call |
| 5 | `CUSTOMER_PROTECTION_PROMPT_SECTION` (complaint/negotiation) — always on telephony | `intent-classifier.ts:1358-1394` | **~620** | static |
| 6 | `buildSpanishCallerPromptSection` (only `language==='es'`) | `:1333-1349` | ~390 | per-call |
| 7 | `CALLER_UTTERANCE_FENCE_PROMPT_SECTION` | `:1457-1460` | ~200 | static |
| U | user msg = `classifierUserContent` → utterance wrapped in `=== UNTRUSTED CALLER CONTENT (BEGIN) === <64-bit id>` fence | `:1503-1512` | ~150 + utterance | per-turn |

Worst structural first turn ≈ 7,600 tok against `CLASSIFY_TURN_INPUT_TOKEN_BUDGET = 9000` (`ai/skills/session-cost-tracker.ts:60`); pinned at 86% by `test/ai/orchestration/classifier-prompt-budget.test.ts:209-243`. **Any new block must be paid for by trimming** (that test's comments are the ledger). Owner-approval and extended-lookup sections never appear on S1 profiles (`:3156-3176`).

**Pre-LLM short-circuits** (`:2903-3110`): deterministic regexes return confidence 0.95 (e.g. `matchNewBookingPhrase`, `matchAppointmentChangeOpening`). Owner-only matchers are gated on `extendedIntents`.

**Returned JSON** (`SCHEMA_HEAD`, `:1013`): `{ intentType, confidence (0..1), reasoning, extractedEntities{…} }`. Parsed by `parseClassifierJson` (`:2545-2640`): strips fences, rejects unknown intents (→ null → `unknown`/`parse_failed`), `confidence` is **the model's self-report**, clamped to [0,1]; enum fields validated, invalid values logged. Calibration text is the only guidance (`CALIBRATION`, `:1098`). Post-parse: sign-up override (`:3240-3275`, pins 0.85), then `isIntentAcceptedOnProfile` guard maps off-profile intents to `unknown`/`intent_off_surface` (audited as `voice.intent_off_surface`, `create-voice-turn-processor.ts:669-700`). Thresholds: `CLASSIFIER_CONFIDENCE_THRESHOLD = 0.6` (`:1238`), FSM `TAU_INT = 0.75` (`ai/agents/customer-calling/transitions.ts:46`), `gateway.complete({ taskType: 'classify_intent', responseFormat: 'json', deadlineMs })` (`:3193`).

**CALLER_INTENTS** (`classifier-profile.ts:185-206`; 18 advertised / 20 accepted):
`create_customer` sign-up · `create_appointment` book a visit · `create_job` open a job · `reschedule_appointment` move a booking · `draft_estimate` "what would X cost" · `lookup_appointments` my next visit · `lookup_invoices` my bills · `lookup_balance` what I owe · `lookup_jobs` my open/recent work · `lookup_agreements` my plan · `lookup_account_summary` "where do I stand" · `lookup_customer` my contact info on file · `lookup_estimates` my quotes · `lookup_availability` open slots (tenant-public) · `confirm` yes to pending readback · `operator_request` human/transfer · `language_switch` en↔es · `unknown` · `complaint` (section) · `negotiation` (section). `emergency_dispatch` deliberately absent (deterministic keyword scan runs first, `emergency-detector.ts`).

## 2. Spoken copy

**One catalog**: `TTS_COPY` in `ai/agents/customer-calling/tts-copy.ts:145-570` — **90 ids**, each `{en, es}`, `{{var}}` placeholders. `ttsCopy(id, lang, vars)` (`:588-593`) interpolates. The FSM (`transitions.ts`) emits the **English sentence** as `payload.text`; transports call `renderTtsText(rawText, payload, lang)` (`:870-960`) which: (a) renders template keys `intent_confirm`/`confirm_intent` (readback via `intentReadbackPhrase`), `disambiguate`, `confirm_entity`, `entity_not_found_operator`, `rebook_offer`, `greeting`, `greeting_with_disclosure`; (b) renders a catalog id with `payload.vars`; (c) reverse-maps an English sentence to its id for Spanish (`EN_SENTENCE_TO_ID`, `:611`); (d) passes anything else through verbatim. Lookup answers arrive as `tts_play {text: summary, source: 'lookup_skill'}` (`create-voice-turn-processor.ts:6161-6172`) — plain strings composed by skills.

**Persona interpolation**: `settings/voice-persona-resolver.ts:65-112` reads `tenant_settings.voice_agent_name / voice_greeting / business_name` (60 s LRU) → `VoicePersona{agentName, greeting, businessName}`. `telephony/twilio-adapter.ts:525-550` `buildTelephonyGreeting(businessName, disclosure, persona, language)`: branch 1 custom greeting verbatim + disclosure (not localized); else `t('greeting.opener_named'|'opener_default', {business, agent})` + disclosure + CTA. **Today nothing in the web app writes `voice_agent_name`/`voice_greeting` except onboarding `PUT /api/onboarding/voice` → `voice/voice-config.ts:36-39` (writes `voice_id` + `voice_greeting`, Vapi-era preset ids); no settings sheet exposes them** (grep of `packages/web/src/components/settings` is empty).

**Is there LLM-generated caller-facing text on the phone?** **No.** Only two gateway task types reach the voice paths: `classify_intent` (JSON) and `summarize_conversation` (`ai/skills/summarize-session.ts:199`, owner-facing). `sentiment-classifier.ts:164` and `vulnerability-grader.ts:106` are internal graders. `escalation-summary-builder.ts:1-10` is explicitly template-based ("adding an LLM call here would block … add fabrication risk"); `ask-caller-request.ts` and `confirm-turn-question.ts` are regex cue checks; `ai/tasks/onboarding/clarification-generator.ts` is onboarding (chat), not phone. The negotiation holding line is swapped by `brandVoiceNegotiationTts` (`conversations/negotiation/acknowledgment.ts:44-88`) — deterministic, "never LLM". Pack `objectionScripts` reach the *classifier prompt* only; nothing consumes `objection_detected` (grep empty), so reframes are never spoken. Pack `repairTemplates` are only wired on the in-app adapter (`inapp-adapter.ts:1236,1527`), not the phone.

## 3. Lookups (template for a new intent)

**Flow**: `speechTurn` (`create-voice-turn-processor.ts:6154-6176`): `intent_classified && confidence >= TAU_INT && isLookupIntent (startsWith 'lookup_', intent-classifier.ts:664) && servesFamilyHere('lookup')` → `answerPhoneLookup` → speak summary + `TTS_COPY.anything_else`; FSM stays in `intent_capture` (no proposal). Gather adapter has the same branch.

**`ai/voice-turn/phone-lookup-surface.ts:143-270`** (phone-only rules): customer-scoped intent without `session.customerId` → `UNIDENTIFIED_CALLER_LINE` (:108); **default-deny allowlist** (:179-186): no `actorUserId` ⇒ only `CUSTOMER_SCOPED_LOOKUP_INTENTS` + `PHONE_PUBLIC_LOOKUP_INTENTS = {lookup_availability}` (:115-117) are answered, everything else `refusalSummary(intent)`; resolves `jobReference`/`targetTechnicianName` via `resolveLookupReference` (ambiguity → `ambiguousReferenceLine`); calls `executeLookupAnswer` with `{tenantId, sessionId, intent, actorId?, customerId?, timezone, language, now}`; emits `lookup_executed` telemetry for every outcome.

**`workers/voice-lookup-answer.ts`** (shared with chat/memo): RBAC gate `LOOKUP_REQUIRED_PERMISSION` (:125-139: revenue/job_profit/pending_items/digest/crew_schedule/timesheets → `reports:view`; leads → `customers:view`; catalog → `settings:view`) checked via `actorHolds` (:349) → refusal copy, never data; customer-scoped set (:150-159); self-scoped `lookup_my_day`/`lookup_next_job` (:169-172); switch (:504-1200) one `case` per intent, each calling an `ai/skills/lookup-*.ts` skill and returning `buildAnswer(intent, 'found'|'none'|'refused', summary ≤2000 chars, rows≤N)` validated by `voiceLookupAnswerSchema` (:382-399). `summary` is the TTS-ready sentence. 20 lookup intents today (D-026, `docs/decisions.md:630-660`).

**Minimal file set for a new lookup-style intent** (per `docs/solutions/workflow-issues/adding-a-voice-intent-requires-four-coordinated-updates.md` + D-034):
1. `intent-classifier.ts` `SUPPORTED_INTENTS`/`IntentType`, bump `INTENT_TAXONOMY_VERSION` + its test pin.
2. `intent-taxonomy-blocks.ts` `INTENT_BLOCKS` entry (+ `ENTITY_FIELDS` line if a slot).
3. `classifier-profile.ts` `ALL_INTENTS` + `CALLER_INTENTS` (and others as appropriate).
4. `capabilities/capabilities.ts` `{ kind: 'lookup' }` entry; `npm run catalog:generate`.
5. `workers/voice-lookup-answer.ts` new `case` + a skill in `ai/skills/`.
6. `phone-lookup-surface.ts` `PHONE_PUBLIC_LOOKUP_INTENTS` if customers may ask it (argue in `docs/decisions.md`).
7. `tts-copy.ts` ids for the spoken lines (EN+ES).
8. `npm run voice-quality:refresh` (cassettes keyed on prompt hash), raise `EST_SYSTEM_PROMPT_TOKENS` in `packages/voice-eval/live-support.ts`, keep `classifier-prompt-budget.test.ts` under 86%.

## 4. RAG

- Skill `ai/skills/retrieve-context.ts:54-92`: embed query → `repository.search({tenantId, queryEmbedding, sourceTypes?, k (default 5, max 50), minSimilarity (default **0.75** cosine)})`; failure-soft `{status:'unavailable'}`.
- Adapter `ai/orchestration/retrieve-adapter.ts:68-153`: wraps skill, logs to `retrieval_eval_runs` (scrubbed query, chunk ids, scores, franc language).
- Wiring `app.ts:2294-2302`: adapter exists only when `RAG_RETRIEVAL_ENABLED === 'true'` **and** `embeddingProvider` (needs `AI_PROVIDER_API_KEY`, `ai/gateway/factory.ts:517-525`). **Sole consumer today: suggest-reply drafts via `buildSourceContext`** (`routes/conversations.ts:351`, `app.ts:5876`). Nothing on the phone path reads it; `context-builder.ts` is not called from voice.
- Schema `db/schema.ts:1651-1695` (`062_create_knowledge_chunks`): `tenant_id NULL|UUID`, `scope tenant|global` (CHECK coupling), `source_type`, `source_id`, `source_version`, `content`, `content_scrubbed`, `embedding vector(1536)`, `embedding_model CHECK = 'text-embedding-3-small'`, `metadata JSONB`; **`ivfflat (embedding vector_cosine_ops) WITH (lists=100)`**; unique `(scope, source_type, source_id, source_version)`; RLS `tenant_id IS NULL OR = current tenant`.
- Search SQL `ai/training/knowledge-chunks.ts:280-320`: `WHERE (embedding <=> $1) <= 1-minSim [AND source_type = ANY($)] ORDER BY embedding <=> $1 LIMIT k` inside `withTenant` (both tiers via RLS). Metric: **cosine distance `<=>`**, similarity = 1−distance.
- Embedding: `OpenAICompatibleProvider.createEmbedding` (`ai/providers/openai-compatible.ts:293-348`), model locked `text-embedding-3-small`, 1536 dims, base URL `AI_PROVIDER_BASE_URL`.
- Source types (`knowledge-chunks.ts:39-52`): `call_summary, transcript_window, proposal_correction, catalog_item, estimate_template, service_bundle, wording_preference, tenant_setting, vertical_terminology, vertical_category, vertical_training_asset, vertical_eval_scenario`. Writers today: `workers/transcript-ingestion-worker.ts` (call_summary + ~200-token transcript windows at session end), `workers/proposal-correction-worker.ts`.
- Eval: `ai/training/retrieval-eval-run.ts` rows per retrieval, outcome attached later by correction worker.
- **Live-turn budget**: one embedding HTTP call (~80–150 ms) + ivfflat probe (<20 ms at this scale) ≈ 150–250 ms — fits 300 ms only if run **in parallel with classify** (not after) or keyed on a cached per-tenant FAQ embedding set. The no-DB alternative: embed FAQ rows at write time, and at call time match the *classifier's* extracted question slot. No HNSW index; ivfflat with `lists=100` needs `ANALYZE` after bulk loads or recall drops.

## 5. Vertical packs (`verticals/packs/hvac.ts`)

| Content | Examples | Reaches classifier? | Spoken? |
|---|---|---|---|
| `categories` (:13-40) | Installation, AC Repair, Seasonal Tune-Up | yes, "Service types offered" | no |
| `terminology` (:44-120) | Furnace (heater, gas furnace), Refrigerant (freon, r410a) | yes, "Equipment and terminology recognized" | no |
| `intakeQuestions` (:127-149) | "Is this for heating or cooling?", "How old is the unit?" | yes ("Disambiguation questions…") — but the classifier returns JSON, so they're never asked | no |
| `objectionScripts` (:157-183) | price, dispatch_fee, phone_quote, hesitation reframes | yes | **no** (no consumer) |
| `repairTemplates` (:240-245) | `low_intent_confidence` → "Is this about scheduling a visit, or…" | no | in-app only |
| `sttKeywords` (:226-238) | `furnace:3`, `heat pump:3` | no | not reachable on Gather (`twilio-adapter.ts:395-405`); media-streams has the slot (`:867`) |
| `metadata.training_assets` (:185-208) | emergency_rule, eval_scenario | via `vertical_training_assets` rows when activated | no |
| `HVAC_MISSING_ITEM_RULES` (`verticals/missing-items.ts:129`), bundles, wording prefs | AC install → thermostat check $75 | estimate drafting only (`context-assembly.ts:51-129`) | no |

**Pack activation 404 (W14)**: web `VerticalPacksSheet.tsx:12-24` now sends `hvac-v1`/`plumbing-v1`; route `routes/pack-activation.ts:55-57` does `getByPackId` → 404 if unknown; registry is seeded at boot with exactly those ids (`shared/canonical-vertical-packs.ts:52-55`, `app.ts:1455`). **Fixed** for the two canonical packs; onboarding still activates bare `'hvac'` and `resolve-active-pack.ts:248-265` reconciles. Electrical/painting packs exist in `packs/` but aren't seeded or offered in the sheet.

## 6. Standing instructions

`instructions/standing-instructions.ts`: ≤20 active per tenant (:19), ≤5 injected per task (:21), ≤500 chars (:22), scope `{intents?, customerSegment?, amountCents?}` strict. Rendered by `ai/standing-instructions-context.ts:63-76` as a delimited system message (`=== OWNER STANDING INSTRUCTIONS (BEGIN/END) ===`, hardening line, optional `appliedStandingInstructions` ask; claims intersected at :100-113). Injected into **drafting tasks only**: voice-action-router (memo), assistant chat, suggest-reply, brand-voice composer. **Not** on the phone classify or spoken path. They could carry phone "custom instructions" only if a consumer is added — but since no phone text is LLM-generated, there is nothing for them to steer today except a future answer-generation task.

## 7. Tenant settings touching voice (`settings/settings.ts:236-420`, `db/schema.ts`)

| Field (column) | Exposed in web |
|---|---|
| `businessName`, `businessPhone/Email/Address`, `ownerPhone`, `timezone` | BusinessProfileSheet / onboarding |
| `businessHours` (JSONB, :2635), `jobBufferMinutes` (:2638), `hourlyRateCents`, `serviceAreaText/Radius/Zips` (:3829), `laborRateCentsPerHour` (:4603) | ServiceAreaSheet, OperatorHoursSheet |
| `voiceAgentName` (≤80, :2462), `voiceGreeting` (≤500, :2463), `voiceId` (:3817, ElevenLabs preset id, Vapi-era) | **none** (onboarding `/voice` only) |
| `defaultLanguage`, `autoDetectLanguage`, `ttsVoiceEn/Es` (:1912-1915), `supportedLanguages`, `spanishDispatcherUserIds` | SettingsPage (language), tts voices not editable |
| `escalationSettings` JSONB (:2815) incl. channels, triggers, `llm_sentiment_threshold`, `after_hours_voice_mode` (304 backfill), `voice_approval_pin_hash` (settings.ts:95) | CallRoutingSheet; PIN via voice flow |
| `transferNumber`, `backupSupervisorUserId` | CallRoutingSheet, SupervisorBackupSection |
| `e1_reviewed_script` (:6593), `e1_reviewers` (293) | E1ScriptSettingsPage |
| `autonomousBookingEnabled/Threshold`, `autonomousCloseEnabled/MaxCents` | AIApprovalRulesSheet, SettingsPage |
| `voice_quality_sample_rate_pct/daily_cap` (:7578) | CallQualityCard |
| `services_offered TEXT[]`, `service_address` (:3831) | onboarding identity only |

## 8. Business info already captured

`onboarding/contracts.ts:20-54` `BusinessIdentityInputSchema`: businessName, jobBufferMinutes, hourlyRateCents, timezone, ownerPhone, serviceAddress, serviceAreaZips (5-digit), servicesOffered (≤50 × ≤60 chars). `routes/onboarding.ts:330-360` writes `service_address`, `service_area_zips`, `services_offered` (COALESCE). Business hours are set via ServiceAreaSheet → settings. **`services_offered` is read only by `voice/voice-config.ts:54-62` (greeting auto-gen, Vapi) and `workers/provision-twilio.ts:623`** — never by the classifier. `service_area_zips` **is** used live: `ai/voice-turn/service-area-gate.ts` asks a new caller for the ZIP on `create_appointment`/`create_job` and speaks `OUT_OF_SERVICE_AREA_COPY` (:20-30). Business hours feed `lookup_availability` (`voice-lookup-answer.ts:705-730`) and after-hours routing; hourly rate feeds estimates only.

## 9. Guardrails on text

- PII scrub `ai/training/scrub.ts`: entity-based redaction + regex sweep (phone/email/address) + fail-loud residual gate; Presidio adapter (`ai/privacy/presidio-adapter.ts`) is used for training-asset ingestion only.
- `noPiiLeak` (`ai/voice-quality/graders/floor.ts:154-200`): fails if any agent speech contains phone/email/$-balance/fixture customer name before an identity-resolving lookup. Other floors: noAutoMutation, noTenantLeak, complianceGatesRespected (:489-496).
- Negotiation: classifier `negotiation` → FSM speaks `negotiation_holding` (`tts-copy.ts:359`), processor mints an owner `callback` proposal (`create-voice-turn-processor.ts:2285-2320`); agent never negotiates.
- Prices: `ai/resolution/catalog-resolver.ts` — pure, no LLM; tiers `exact/high/ambiguous/none` (`TAU_HIGH 0.85`, `MARGIN 0.15`, `TAU_FLOOR 0.6`, :86-90); `none` ⇒ `uncatalogued`, `requiresReview=true`, confidence capped `UNCATALOGUED_CONFIDENCE_CAP = 0.85` (:100) below auto-approve. Spoken side `ai/voice-turn/quote-readback.ts:9-19`: a number is spoken **only when every line is `pricingSource:'catalog'`**; otherwise `uncatalogued_quote_readback` ("the owner will confirm pricing").

---

## Proposed design

### A. `tenant_business_answers` + FAQ on live calls

**Principle**: keep the phone's "no LLM prose" invariant for the first release. Structured facts are answered by templates; free-form FAQs are retrieved and spoken **verbatim from owner-authored text**, never paraphrased. An LLM-composed answer is a later, guarded step.

**Table `tenant_business_answers`** (one row per tenant; extend `tenant_settings`-style mapping in `settings/pg-settings.ts`):
```
tenant_id UUID PK FK, 
pricing_policy TEXT (≤300)            -- "diagnostic fee $89, credited to repair"
payment_methods TEXT[]               -- ['card','check','cash','financing']
warranty_text TEXT (≤300), license_text TEXT (≤200), insurance_text TEXT (≤200),
emergency_policy TEXT (≤300), service_area_summary TEXT (≤200),
years_in_business INT, brands_serviced TEXT[], financing_available BOOL,
free_estimates BOOL, residential BOOL, commercial BOOL,
updated_at, updated_by
```
Plus **`tenant_faq_entries`** (`id, tenant_id, question TEXT ≤200, answer TEXT ≤500, aliases TEXT[], language 'en'|'es', active BOOL, embedding vector(1536) NULL, embedding_model, updated_at`) — ≤50 per tenant, RLS, `knowledge_chunks`-style unique on `(tenant_id, id, version)`; embed on write via the existing `EmbeddingProvider` (job in the P0-009 worker pattern).

**Template vs retrieval**:
- *Templates* (deterministic, from `tenant_settings` + `tenant_business_answers`): hours/open-now, service area (ZIPs/summary), payment methods, financing, free estimates, warranty, license/insurance, emergency policy, residential/commercial, brands, years in business, services offered (`services_offered`), address/phone. Each is a `tts-copy.ts` id with `{{vars}}` (EN+ES) — e.g. `biz_hours_today`, `biz_payment_methods`, `biz_not_on_file`.
- *Retrieval* (only when no template slot matches): embed the utterance, cosine search `tenant_faq_entries` (tenant tier only; **no global tier** for business facts), speak `answer` verbatim if similarity ≥ 0.80 and the top-2 margin ≥ 0.05; else `biz_not_on_file` ("I don't have that on file — I'll have the team follow up") + capture an owner `callback` note, same as negotiation.

**Classifier block** (add to `INTENT_BLOCKS` and `CALLER_INTENTS`; budget ≈ +130 tok, pay for it by trimming `lookup_customer` examples):
```
- "lookup_business_info" — caller asks a GENERAL question about the business
                           itself, not about their own account: hours, service
                           area, payment methods, financing, warranty, license/
                           insurance, pricing policy, emergency availability,
                           brands/equipment serviced, how long in business.
                           Read-only. Put the topic in businessTopic (one of:
                           hours|service_area|payment|financing|warranty|
                           license|pricing_policy|emergency|brands|about|other)
                           and the caller's question verbatim in questionText.
                           Examples: "Are you open on Saturdays?"
                                     "Do you take credit cards?"
                                     "Do you work on Trane units?"
                           NOT lookup_balance/lookup_invoices (those are about
                           the caller's own account) and NOT draft_estimate
                           (a price for specific work).
```
Entity lines: `"businessTopic": "<enum, optional>"`, `"questionText": "<string, optional — verbatim question on lookup_business_info>"`.

**Wiring**: `lookup_business_info` into `PHONE_PUBLIC_LOOKUP_INTENTS` (argue in D-0xx: reveals only owner-published facts); `case 'lookup_business_info'` in `voice-lookup-answer.ts` → new `ai/skills/lookup-business-info.ts` (topic → template; `other` → FAQ retrieval). Chat/memo get it for free. Timing: template path is one settings read (cached); retrieval path runs embed+search (~200 ms) **after** classify — acceptable because lookups already run post-classify and the filler engine (`filler-engine.ts`) covers the gap.

**Post-check rules for any spoken answer** (apply in the skill before `buildAnswer`): (1) `PHONE_REGEX`/`EMAIL_REGEX`/`BALANCE_REGEX` from `floor.ts` must not match unless the topic is `about` (business phone) — a FAQ answer can't leak a customer; (2) no `$` amounts unless topic is `pricing_policy` *and* the amount string is byte-equal either to owner text or to the deterministic money formatter's rendering of a confirmed structured fee (`trip_fee_cents` / `deposit_cents` with `*_confirmed_at` set — plan U4/U5); never arithmetic, never an LLM-emitted figure; (3) ≤ 2 sentences / 280 chars — enforced at FAQ save time (plan U4) so stored answers always fit and play verbatim; at call time the bound is a tripwire only: an over-length answer is refused (`biz_not_on_file`, row flagged for review, audited), never truncated, since a dropped second sentence can drop the caveat; (4) answer language must equal `session.language` (store per-language rows; no on-the-fly translation); (5) strip anything matching `buildUntrustedContentSection` fence markers; (6) log `lookup_executed` with `similarity` so `retrieval_eval_runs` can grade it. Later LLM-composition step (if ever) must be gated by `RAG_RETRIEVAL_ENABLED`-style flag, cite the FAQ id, and pass rules 1–5 plus a "contains no token outside the source answers + template words" check.

### B. Per-tenant persona

1. **Resolver** (`settings/voice-persona-resolver.ts:18-42`): extend `VoicePersona` with `ttsVoiceId?: string` (ElevenLabs id from a new `tenant_settings.tts_voice_id` column — reuse `voice_id` only if Vapi presets are retired), `style?: 'warm'|'professional'|'brief'`, `signOff?: string`, `pronunciation?: Record<string,string>` (fed to `speakableText`). Settings sheet: new `VoicePersonaSheet.tsx` exposing agentName, greeting (with live `buildTelephonyGreeting` preview), voice picker, style; `PUT /api/settings/voice-persona` (owner, `settings:update`, audit `tenant.voice_persona_set`), invalidate the 60 s cache on write.
2. **TTS provider** (`ai/tts/tts-provider.ts:21-39`): add `voiceId?: string` to `TtsSynthesizeInput`/`TtsSynthesizeStreamInput`; `ElevenLabsTtsProvider` (:157-250) uses `input.voiceId ?? this.voiceId` in the URL and the WS connection key; OpenAI maps `voiceId` onto its `voice` enum or ignores. Mediastream call sites `mediastream-adapter.ts:3149-3154, 3230, 3346` pass `voiceId: this.state.persona?.ttsVoiceId`. Thread persona onto session state at establishment (where `buildTelephonyGreeting` already receives it).
3. **Gather `<Say>`** (`twilio-adapter.ts:684-693`): today `voiceOverride = settings.ttsVoiceEn/Es` (`:1030`), defaults `Polly.Joanna` / `Polly.Mia-Neural` (`telephony/shared/safety-say-lines.ts:13-14`). Map persona → Polly: store `pollyVoiceEn/Es` on the persona (validated against an allowlist: Joanna, Matthew, Salli, Joey, Kendra / Mia-Neural, Lupe-Neural, Pedro-Neural) and set `voiceOverride` from it; keep the "line in other language keeps that language's default" rule (`:678-690`).
4. **Filler cache** (`filler-audio-cache.ts:80-181`): key is `filler.id` today, synthesized with the provider's default voice. Change to `${voiceId}:${filler.id}` (bounded: ≤ N distinct voices in memory, LRU on voiceId), and `fillerSynthesizerFromTts` passes `voiceId`. The selected voice's clips are pre-synthesised when the persona is previewed or saved (`POST /voice/preview`, `PUT /api/settings/voice-persona` kick `startFillerSynthesis`) and warmed at boot for every tenant's saved voice id. **Never substitute the default voice**: if a clip is missing when a turn needs it, the turn runs without filler (silence until the first real frame, as Gather does today) and increments `voice_filler_miss_total{voice_id}`. A default-voice filler followed by a selected-voice reply is the audible mid-turn speaker change R4 forbids. (An earlier draft of this item said "fall back to the default-voice clip"; plan U3 supersedes it.)
5. Persona is identity/tone only — **it never changes classifier text** (keeps cassette hashes stable) and never injects free text into prompts; `greeting`/`signOff` are spoken verbatim through `renderTtsText` passthrough.

# 01 — Track 1: AI Interaction & Prompt Architecture

Date: 2026-07-18 · Read-only discovery · Evidence verified against HEAD `a9d06aa`
See `discovery/00-cartography.md` for repo orientation.

## Summary

This lane is substantially stronger than the average AI product codebase — and one headline operator claim is false. The **"production `/goal` prompt suite" does not exist**: no such directory, route, module, or file exists in the working tree or anywhere in git history (`git log --all -- '*goal*'` returns nothing). Prompts are hardcoded inline constants in `ai/orchestration/`, `ai/tasks/*`, and `ai/agents/*`. That said, the inline prompts themselves are unusually disciplined: a ~500-line intent-classifier system prompt with a versioned taxonomy (`INTENT_TAXONOMY_VERSION = '1.3.0'`), deterministic regex overrides layered over the LLM, hand-rolled but thorough output validation, and a genuinely excellent money-grounding chain (catalog resolver → confidence cap → threshold-independent `requiresReview` → quote readback that never speaks an LLM-invented number). The gateway is production-grade (tiered routing, per-tenant quotas, breakers, deadlines, micro-cent cost accounting, `ai_runs` audit rows).

The biggest structural problem is evidentiary: the voice-quality gate that blocks PRs and deploys **never calls an LLM** — cassettes are recorded from a mock that echoes each script's own expected intent, and the answer-correctness judge is hardwired to pass. Real-model evaluation exists (Layer 2 with 3× voting, weekly intent/slot evals with ≥92%/≥0.88 targets) but none of it sits on the push-to-main → Railway deploy path. Second: the anti-negotiation/complaint guardrails are classifier-unreachable on ordinary customer calls (gated on `ownerSession`, acknowledged in a comment as "unwired today"). Third: prompt versioning infrastructure exists but is vestigial — one registered prompt (`brand_voice_v1`); every other prompt change ships silently with only git as the record. Injection defense is architectural (separate system messages, BEGIN/END delimiters, output intersection, price grounding) rather than detective — the FSM's `prompt_injection_detected` event has no producer.

## What exists (inventory)

| Asset | Maturity | Evidence |
|---|---|---|
| LLM gateway (routing, tiers, quotas, breaker, deadlines, cost accounting, `ai_runs`) | **Hardened** | `packages/api/src/ai/gateway/gateway.ts`, `compose-resilience.ts`, `breaker.ts`, `tenant-quota.ts`, `config/ai-routing.ts` |
| Intent classifier (57 intents, versioned taxonomy, deterministic overrides, enum validation) | **Hardened** | `ai/orchestration/intent-classifier.ts:539-1056` (prompt), `:242` (version), `:1229-1389` (parser) |
| Catalog price grounding + quote readback | **Hardened** | `ai/resolution/catalog-resolver.ts:70-101`, `ai/voice-turn/quote-readback.ts:139-168` |
| Customer-calling FSM (pure reducer, side-effects-as-data, global guards) | **Hardened** | `ai/agents/customer-calling/transitions.ts:171-360`, `types.ts` |
| Task drafting handlers (estimate/invoice/appointment/edits/MMS) | **Working** | `ai/tasks/*.ts`; hand-rolled JSON parsing, Zod only at scattered edges |
| Onboarding agent (FSM + 5 extractors → proposals, human-reviewed) | **Working** | `ai/agents/onboarding/transitions.ts`, `ai/tasks/onboarding/*`, `ai/orchestration/onboarding-conversation.ts` |
| Supervisor review gate (3 deterministic checks + 1 cheap-model LLM check, fail-open) | **Working** | `ai/supervisor/reviewer.ts` |
| Sentiment / vulnerability / frustration graders | **Working** (weakest prompt hygiene) | `ai/agents/customer-calling/sentiment-classifier.ts`, `vulnerability-grader.ts` |
| Voice-quality harness Layer 1 (66 scripts, 11 buckets, 8 safety floors, cassette replay) | **Working** — but LLM-free | `ai/voice-quality/**`, `test/voice-quality/voice-quality-driver-factory.ts:271-333` |
| Voice-quality Layer 2 (real Anthropic+OpenAI, 3× voting, $10 cap) | **Working**, release-branch only | `.github/workflows/voice-quality-pre-deploy.yml` |
| voice-eval package (intent ≥92% / slot ≥0.88 live evals) | **Working**, weekly cron, non-blocking | `packages/voice-eval/`, `.github/workflows/voice-eval-live.yml` |
| Prompt registry / versioning | **Prototype** (vestigial: one entry, in-memory + one DB thread) | `ai/prompt-registry.ts` (only `brand_voice_v1` at `:136`) |
| PII redaction (Presidio, fail-closed) | **Working** — training assets only, not live transcripts | `ai/privacy/presidio-adapter.ts` |
| "/goal prompt suite" | **Does not exist** | Not in tree; not in git history |

## Findings

---

**T1-F01 | The AI quality gate on the deploy path never calls an LLM | Gap | Critical**
**Evidence:** `test/voice-quality/voice-quality-driver-factory.ts:271-333` — `ScriptAwareMockGateway` synthesizes classifier output *from the script's own `expected.intent`*; `JUDGE_PASS_JSON` (`:34-38`) makes the answer-correctness criterion structurally always-pass. `deploy.yml` (push→main→Railway) gates only on this Layer 1 replay; `voice-quality-pre-deploy.yml` (the only real-LLM enforced gate) triggers on `release/*` branches, which are not on the main deploy path.
**What & Why:** The gate that looks like an AI eval proves FSM/plumbing/safety-floor behavior, not model behavior. A regression in the classifier prompt, model swap, or provider drift ships to production having passed "voice-quality" green. Real-model evidence (weekly `voice-eval-live` ≥92% intent, Layer 2 voting) is cron-only or on branches that may never be cut.
**Effort:** M. **Plan:** (1) Add a cheap real-LLM smoke (10-15 canonical scripts, cost-capped ~$1) as a required PR or pre-deploy job with keys; (2) or make `release/*` the actual deploy branch so Layer 2 gates for real; (3) surface "Layer 1 is LLM-free" in the workflow name/report to stop it masquerading.
**Confidence:** H (two independent sweeps + workflow reads agree).

---

**T1-F02 | Negotiation/complaint guardrails are unreachable on customer calls | Gap | High**
**Evidence:** `telephony/twilio-adapter.ts:1040-1042` — `// Live-call customer complaint handling is unwired today...` `const extendedIntents = extendedIntentsFlag && ownerSession;`. The classifier only documents/emits `negotiation`/`complaint` when `extendedIntents` is true (`intent-classifier.ts:1096-1150`); the FSM's N-003 holding-line + owner-callback guard (`transitions.ts:284-325`) therefore never fires for a haggling **customer** — the exact population it was designed for ("the AI never negotiates").
**What & Why:** A customer saying "knock $50 off or I leave a 1-star" routes to `unknown`→clarification instead of the deflect-and-escalate path. Belt-and-braces gating (`EXTENDED_INTENT_TYPES` re-check) is correct engineering, but the enable condition conflates "owner extended lookups" with "customer-side protection intents."
**Effort:** S-M. **Plan:** Split the gate: customer sessions get a `customerProtectionIntents` prompt section (complaint/negotiation only); owner sessions keep the lookup family. Add a corpus script asserting the holding line on a non-owner session.
**Confidence:** H (comment self-documents the gap).

---

**T1-F03 | No injection detection on the caller→LLM path; declared FSM event is dead; guard drift across prompts | Gap | High**
**Evidence:** `ai/agents/customer-calling/types.ts:95` — `{ type: 'prompt_injection_detected' }` has **zero producers or consumers** (single grep hit repo-wide). `ai/tasks/invoice-task.ts:19-35` — `INVOICE_SYSTEM_PROMPT` lacks the "data only" injection guard its estimate/MMS/onboarding siblings carry (`estimate-task.ts:49`, `mms-estimate-task.ts:74`), while echoing entity JSON into the user message (`:311`).
**What & Why:** Callers are untrusted input on a live line. Defenses that DO exist are good — transcript always a separate `user` message in the classifier (`intent-classifier.ts:1542-1547`), owner standing-instructions wrapped in delimiters with a hardening line and id-intersection (`standing-instructions-context.ts:41-113`), all money/ids grounded post-hoc. But there is no detection layer (the dead event proves it was planned), the guard language is inconsistent per prompt, and the adversarial corpus bucket (10-adversarial) runs at a 70% threshold against a mocked LLM (see T1-F01), so injection resistance is untested against real models on any gate.
**Effort:** M. **Plan:** (1) Delete or wire `prompt_injection_detected` (repo hygiene rule mandates removing dead code); (2) extract a shared `UNTRUSTED_INPUT_GUARD` constant into every drafting prompt; (3) run bucket 10 in the real-LLM smoke from T1-F01.
**Confidence:** H.

---

**T1-F04 | `assessConfidence` trusts the model's self-reported score, and it feeds auto-approval | Fix | High**
**Evidence:** `ai/guardrails/confidence.ts:51-65` — `score = aiOutput.confidence_score` (model-controlled, default 0.5), "factors" are payload key-counts. Auto-approve requires trust-tier `autonomous` + `capture` action class + ≥0.9 (`confidence.ts:6-16`), so a model that self-reports 0.9 on a capture-class draft self-approves. Money paths are protected independently (`UNCATALOGUED_CONFIDENCE_CAP = 0.85` + structural `requiresReview`, `catalog-resolver.ts:95-101`), which is why this is High not Critical.
**What & Why:** An LLM-emitted number is the deciding input to a human-bypass decision. Also, `confidence.ts:14-16` still cites the removed `/experiments` prototype (`service-os-agent/mcp_servers/money_server.py` — path does not exist) as a "second gate," which is stale and misleading.
**Effort:** S-M. **Plan:** Derive confidence from verifiable signals (entity-resolution outcome, grounding cleanliness, enum-validation hits — `invalidEnumFields` already exists) and treat model self-report as a cap, not a floor. Fix the stale doc reference.
**Confidence:** H on mechanism; M on real-world exposure (depends on which tenants run `autonomous` tier).

---

**T1-F05 | Prompt versioning is vestigial — every prompt but one ships untracked | Gap | Medium**
**Evidence:** `ai/prompt-registry.ts:136` — only `BRAND_VOICE_PROMPT_VERSION_ID = 'brand_voice_v1'` is ever registered; its "template" is a placeholder string (`:193-196`). `PromptVersionRepository` is referenced by no other module. `ai_runs.metadata.promptVersionId` (`gateway.ts:449`) is null for every classify/draft/extract run. The intent taxonomy has a real version constant (`INTENT_TAXONOMY_VERSION`), but the *prompt text* itself has no version stamp.
**What & Why:** No rollback, no A/B, no way to correlate a proposal-quality regression with the prompt that produced it. Combined with T1-F01, a prompt edit is effectively unobservable end-to-end.
**Effort:** M. **Plan:** Stamp a content-hash or manual semver per prompt constant into `metadata.promptVersionId` at each call site (the plumbing already exists all the way to `ai_runs`); delete the unused registry or back it with the real table.
**Confidence:** H.

---

**T1-F06 | Session cost cap runs on a hardcoded price guess, not the gateway's real cost | Fix | Medium**
**Evidence:** `ai/skills/session-cost-tracker.ts:36-50` — `estimateCostCents` uses a fixed Sonnet-class blend ($3/$15 per MTok) with the comment "Replace with provider-reported pricing once the gateway threads it through." The gateway *does* now thread real cost (`gateway.ts:497` `computeCostMicroCents`), but `create-voice-turn-processor.ts:691-711` (`recordCost`) still calls the estimate.
**What & Why:** Voice classify traffic is lightweight-tier Haiku (`config/ai-routing.ts:25,115`), ~3.75× cheaper than the estimate — the $0.40/call telephony cap (`DEFAULT_TELEPHONY_CAPS`) fires early, escalating callers to humans on calls that actually cost ~10¢; a future pricier model would silently under-enforce. The intended fix is already half-built.
**Effort:** S. **Plan:** Thread `LLMResponse.costMicroCents` into `recordCost`; keep the estimate only as fallback for null-priced models.
**Confidence:** H.

---

**T1-F07 | Failover is a no-op: one real provider, plus a dead second failover implementation | Gap/Refactor | Medium**
**Evidence:** `ai/gateway/factory.ts:108-149` builds exactly one `OpenAICompatibleProvider`; `compose-resilience.ts:29-33` documents "single-provider scenario... exhausts the list and throws immediately"; `fallbackProviders` is never populated by any caller. Separately, the entire `FailoverGateway` class (`ai/gateway/failover.ts`, 263 lines, cheaper-model cascade, cached stage, error envelope) has **no non-test importers** — dead code under the repo's own hygiene rule.
**What & Why:** A provider/endpoint outage is a total AI outage: breakers open, every live call degrades to human escalation (safe, but at 1,000 concurrent sessions that's 1,000 simultaneous on-call pages/transfers). `LLMResponse.fallbackStage`/`degraded` fields imply capabilities that don't operate.
**Effort:** M (wire a second provider through env) / S (delete dead class). **Plan:** Provision `fallbackProviders` from a second base-URL/key pair; delete or wire `failover.ts`; load-test the escalation fan-out.
**Confidence:** H.

---

**T1-F08 | Per-tenant quota exhaustion is spoken to callers as "didn't catch that" | Fix | Medium**
**Evidence:** `tenant-quota.ts:38-43` — standard tier `maxConcurrency: 8` (reject, not queue). `create-voice-turn-processor.ts:2700-2706` — any `classifyIntent` throw (including `TenantConcurrencyExceededError`) maps to `{ type: 'confidence_low', score: 0 }` → the FSM reprompts the caller to repeat themselves.
**What & Why:** A busy tenant (9+ simultaneous calls) gets callers stuck in repeat-yourself loops until retry-count escalation, misdiagnosed as speech trouble. At scale this is the first failure mode a growing tenant hits; the error carries `retryAfterMs: 1000` that nothing on the voice path uses.
**Effort:** S-M. **Plan:** Catch quota/breaker errors distinctly in the speech-turn handler; speak a "one moment" filler + short retry (filler-engine already exists), else escalate with a truthful reason; alert on `TENANT_CONCURRENCY_EXCEEDED` rates.
**Confidence:** H on code path; M on operational frequency.

---

**T1-F09 | Raw caller transcripts (PII) persist unredacted in `ai_runs` snapshots | Gap | Medium**
**Evidence:** `gateway.ts:313-359` — `redactMessagesForSnapshot` redacts **image** parts only ("Text is preserved for debugging"); every classify/draft call writes full message text — names, phones, addresses spoken on calls — to `ai_runs.input_snapshot`. Presidio fail-closed redaction (`ai/privacy/presidio-adapter.ts`) applies only to the training-asset pipeline.
**What & Why:** Deliberate trade-off (debuggability) but inconsistent with the image-part rationale ("avoid PII at rest") and untracked as a retention decision. Voice transcripts are the highest-PII surface in the product.
**Effort:** M. **Plan:** Either document retention + add TTL/purge on `ai_runs` input snapshots, or run the deterministic `scrubPii` pass over snapshot text at write time.
**Confidence:** H.

---

**T1-F10 | Sentiment & vulnerability graders: instructions and caller text in one user message, silent zero on failure | Fix | Medium**
**Evidence:** `app.ts:3968-3980, 4016-4031` — both graders send `SYSTEM_PROMPT + transcript` concatenated as a single `user` message (no system role, no `responseFormat: 'json'`). `vulnerability-grader.ts:97-103, 134-136` and `sentiment-classifier.ts:82-99` — bare `catch { return ZERO_GRADE }` with no logging or metric.
**What & Why:** Weakest injection posture in the codebase (blast radius is bounded — outputs are clamped scores/enums — but a caller can trivially steer their own vulnerability/frustration grade). Worse: `grade_vulnerability` is a *safety* feature that fails open to "not vulnerable" invisibly; a provider brownout means vulnerable-caller triage silently stops with zero observability.
**Effort:** S. **Plan:** Split into system+user messages, set `responseFormat: 'json'`, add a warn log + counter on the catch paths, and consider fail-differently for `grade_vulnerability` (e.g., mark grade as `unavailable` so the triage hook can bias conservative).
**Confidence:** H.

---

**T1-F11 | ~4K-token classifier prompt on every voice turn; response cache off by default; no provider prompt caching | Gap | Low-Med**
**Evidence:** `intent-classifier.ts:539-1056` — the base `SYSTEM_PROMPT` alone is ~500 lines, sent every caller turn on the lightweight tier; `factory.ts:160` — `AI_CACHE_ENABLED !== 'true'` → no cache wrapper; `providers/openai-compatible.ts` sets no prompt-cache headers/`cache_control`.
**What & Why:** On Haiku this is cheap in absolute terms (~0.5-1¢/turn; per-session cap 40¢), so it's a scaling-cost issue not a today-issue — at 1,000 concurrent sessions, repeated static-prefix tokens dominate spend. Anthropic prompt caching on the stable prefix (the byte-identical-prompt discipline the code already maintains for cassette hashes makes it cache-ideal) would cut classify input cost ~90%.
**Effort:** M. **Plan:** Enable provider-side prompt caching for the static system prefix; revisit whether all 57 intent definitions must ride every turn or can be tiered by session type.
**Confidence:** H on facts; M on savings estimate.

---

**T1-F12 | Output validation is hand-rolled and duplicated; Zod contracts only at scattered edges | Refactor | Low**
**Evidence:** Near-identical `tryParse*Json` in `estimate-task.ts:51`, `invoice-task.ts:37`, `mms-estimate-task.ts:109`, `create-appointment-task.ts:88`, `tasks/onboarding/utils.ts:8`. Full-payload Zod (`assertValidProposalPayload`) is called by `mms-estimate-task.ts:302` and `create-customer-task.ts:416` but not by the estimate/invoice/edit handlers; onboarding extractors have no Zod at all.
**What & Why:** The manual guards are actually thorough (typed enum tables, `invalidEnumFields` telemetry in the classifier is a standout), so this is consistency debt, not a live bug — but the CLAUDE.md claim "all proposals: typed payloads validated by Zod contracts" is only partially true at the drafting layer.
**Effort:** M. **Plan:** One shared `parseLlmJson<T>(schema)` helper; route every handler's output through its proposal-contract schema before persist.
**Confidence:** H.

---

**T1-F13 | Dead/dormant AI modules contradict the repo's own hygiene mandate | Refactor | Low**
**Evidence:** `ai/tasks/onboarding/clarification-generator.ts` (`generateAIClarificationQuestions` — exported, never called); single-shot `ai/orchestration/onboarding.ts` orchestrator (self-described "dormant... never persists its output" at `onboarding-conversation.ts:344-346`); `ai/gateway/failover.ts` class (see T1-F07); `types.ts:95` dead FSM event (see T1-F03); stale `/experiments` reference in `confidence.ts:14-16`.
**Effort:** S. **Plan:** Delete per the CLAUDE.md dead-code rule; each is a mislead for future contributors.
**Confidence:** H.

---

**T1-F14 | Onboarding: raw LLM prices flow into template proposals; review state auto-confirms | Gap | Low**
**Evidence:** `ai/tasks/onboarding/template-assembler.ts:104` — `defaultUnitPriceCents` taken directly from the pricing-extractor's LLM output into `onboarding_estimate_template` proposals (no catalog exists yet at onboarding; human review is the only gate). `agents/onboarding/transitions.ts:156-166` — the in-conversation `review` state treats **any** utterance as confirmation (comment acknowledges MVP).
**What & Why:** Both are mitigated by mandatory per-card proposal approval (nothing auto-applies), but these seeded prices become the tenant's future *grounding source* — an error here propagates into everything the catalog resolver later treats as authoritative.
**Effort:** S. **Plan:** Add integer/range sanity checks (Zod) on extractor money fields; make the review state require an affirmative match.
**Confidence:** H.

---

## Genuinely solid

- **Money grounding chain** — `catalog-resolver.ts` (price-conflict detection with dual rel/abs thresholds, threshold-independent `requiresReview`, empty-catalog `markAllUncatalogued` fallback) + `quote-readback.ts` (all-or-nothing no-number rule, pinned strings). An LLM-invented price cannot be spoken or auto-approved. This is the best-engineered part of the lane.
- **Intent classifier engineering** — versioned taxonomy, deterministic regex short-circuits layered over the LLM (signup leak fix P18-001), byte-identical-prompt discipline for cache/cassette stability, `invalidEnumFields` drift telemetry, low-confidence → structured clarification (never a silent drop).
- **Gateway** — `enforceTopLevelTenantId` (strict in dev/CI, warn in prod) shows a team that found and permanently fenced a real cross-tenant quota/cache bug; micro-cent cost accounting priced at the model that actually served (post-failover); per-tier deadlines tuned to the voice SLO.
- **Standing-instruction injection defense** (`standing-instructions-context.ts`) — delimiters, hardening line, claimed-id intersection — is a model for how the rest of the prompts should treat untrusted-ish text.
- **The eval harness architecture** (8 safety floors, bucketed corpus, majority voting, cost caps) is well-designed; the problem is *where it runs* (T1-F01), not what it is.

## Could not verify

- Whether `release/*` branches are ever actually cut (i.e., whether the Layer 2 real-LLM gate has ever run in anger) — needs CI run history, not repo contents.
- Real-world auto-approve exposure for T1-F04 — which live tenants run `sourceTrustTier: 'autonomous'` is data, not code.
- Live intent-classification accuracy on production traffic — the offline baseline in `packages/voice-eval/README.md` (~62% intent for the rule baseline) is not the LLM's number; the ≥92% live target's latest pass/fail requires CI artifacts.
- Whether `AI_CACHE_ENABLED`, `REDIS_URL`, `SHADOW_LLM_ENABLED`, and the per-tier model env vars are set in the Railway environment (defaults analyzed above assume unset).
- Frequency of `TenantConcurrencyExceededError` in production (T1-F08 severity calibration).

# Phase 4 (Vertical Packs + Estimate Intelligence) — Multi-Agent Dispatch Addendum

This addendum extends `docs/stories/phase-4-gap-stories.md` with the metadata needed to dispatch each story to a Claude agent running in an isolated worktree.

For every story, the agent prompt should include:
- The full body of the story from `phase-4-gap-stories.md`
- This addendum's per-story block
- `repository-conventions.md` and `freeze-list.md` from `docs/superpowers/contracts/`

## Wave plan

| Wave | Stories | Run-mode | Blocks |
|---|---|---|---|
| 4-Wave-C0 | P4-015 | single agent (touches the shared prompt registry — minimal contention) | unblocks Wave C1: P6-028, P7-026, P8-015 |

P4-015 (brand-voice prompt + composer) is a Wave-C blocker for three downstream stories that draft customer-facing text. See `docs/superpowers/plans/2026-05-17-wave-c-bad-day-recovery.md` for the wave-level context.

---

## P4-015 — Brand-voice prompt and composer

**Wave:** 4-Wave-C0 (Wave-C blocker B1)
**Migration number reserved:** `110_tenant_settings_brand_voice` — CORRECTION (post-dispatch): the original "migration 090" premise was **wrong**. Migration 090 is `090_tenant_settings_voice_persona` (voice agent name/greeting), not brand voice. The `brand_voice` JSONB column did NOT exist and was created in migration 110 during this story's dispatch.
**Forbidden files:**
- `packages/api/src/ai/gateway/**` (the composer routes via the gateway — do not modify the gateway itself)
- `packages/api/src/ai/orchestration/**` (orchestration is unchanged)
- `packages/api/src/ai/providers/**` (provider wiring is unchanged)
- `packages/api/src/ai/skills/**` (existing skills are not touched in this story)
- `packages/shared/**`
- ~~`packages/api/src/db/**` (no schema change — `tenant_settings.brand_voice` is already a JSONB column)~~ — CORRECTION: the column did NOT exist. Migration `110_tenant_settings_brand_voice` plus the typed `BrandVoiceSettings` field and read/write wiring in `settings/settings.ts` + `settings/pg-settings.ts` were added to create it. These files were necessary deviations from the original (incorrect) forbidden list.

**Allowed files (concrete list):**
- `packages/api/src/ai/brand-voice/composer.ts` (new)
- `packages/api/src/ai/brand-voice/composer.test.ts` (new)
- `packages/api/src/ai/brand-voice/prompts.ts` (new — the four intent prompt templates)
- `packages/api/src/ai/brand-voice/prompts.test.ts` (new — golden output smoke tests)
- `packages/api/src/ai/prompt-registry.ts` (modify — register `brand_voice_v1` prompt-version)

**Verification gate (single command):**
```bash
cd /home/user/Serviceos && \
  npx tsc --project packages/api/tsconfig.build.json --noEmit && \
  npm test --workspace=packages/api -- --run -t "P4-015|brand-voice|composeBrandVoiceMessage"
```

**Pre-flight:** none.

**Risk note:**
- **Tone is the authority, not context.** The prompt template puts tenant tone above caller-provided `context`. A handler that puts user input in the tone slot would be a jailbreak; the composer enforces tone as a non-overridable system instruction.
- **`maxChars` enforced AFTER generation.** Models routinely overrun length budgets. Truncate to the last full word boundary; only append `...` if the truncation actually removed content.
- **Gateway failover applies.** Route via `aiGateway.run('brand_voice_v1', {...})` so retries/breaker/failover work without bespoke code. Do NOT call OpenAI/Anthropic SDKs directly.
- **PII opt-in.** The composer signature includes `context: Record<string, unknown>` — the prompt template only references fields the caller explicitly passes. Defaulting to "include all context" would leak PII to the model unnecessarily.
- **Defer golden-example dataset.** V1 ships with the four intents registered and one smoke test per intent that asserts non-empty + length-cap. The full quality-regression dataset is a follow-up story.

**Implementation hints:**
1. Read `packages/api/src/ai/prompt-registry.ts` first — see how `PromptVersion` is shaped and how existing prompts register.
2. Read `packages/api/src/ai/gateway/gateway.ts` to confirm the `run(promptVersionId, payload)` signature; use it as-is.
3. The tenant-tone schema lives on the `tenant_settings.brand_voice` JSONB column (created in migration 110, NOT 090) with fields `formality: 'casual'|'professional'`, `pronoun: 'we'|'i'`, `vibe_words: string[]`, `business_name`. See the `BrandVoiceSettings` interface in `settings/settings.ts`.
4. Intents register as `('brand_voice_v1', 'tech_reschedule_customer_sms')`, etc. Use a tagged-union approach so adding a new intent is one entry, not a copy-paste of the whole prompt.
5. The smoke test mocks the gateway provider and asserts the composer threads `tone + intent + context` into the prompt and respects `maxChars`. Real-model golden tests are deferred.

---

## Universal pre-flight checks

Same as `p0-dispatch-addendum.md` § Universal pre-flight checks. Apply to every Phase 4 story before launching the dispatch agent.

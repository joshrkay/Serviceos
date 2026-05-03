# Phase 11 (Voice Parity) — Multi-Agent Dispatch Addendum

This addendum extends `docs/stories/phase-11-gap-stories.md` with the metadata needed to dispatch each story to a Claude agent in an isolated worktree.

For every story, the agent prompt should include:
- The full body of the story from `phase-11-gap-stories.md`
- This addendum's per-story block
- `repository-conventions.md` and `freeze-list.md` from `docs/superpowers/contracts/`

## Wave plan

| Wave | Stories | Run-mode | Blocks |
|---|---|---|---|
| 11A | P11-001 | single agent (touches db/schema 061 + intent classifier + adapter) | unlocks 11B |
| 11B | P11-002 | single agent (cross-cutting i18n; large diff surface) | unlocks 11C edits |
| 11C-1 | P11-006 | parallel-eligible after 11A merges | unlocks 11C-2 |
| 11C-2 | P11-007 | parallel-eligible after P11-006 merges (LineItemEditor reuse) | none |
| 11C-3 | P11-008 | parallel-eligible after P11-006 merges | none |

P11-001 ships alone because it touches the intent classifier (a high-blast-radius file). P11-002 ships alone because it's cross-cutting (i18n catalog + every skill + every provider). P11-006 unblocks the rest of the UI catch-up; 007 and 008 can run in parallel after.

---

## P11-001 — Voice lookup skill family

**Wave:** 11A
**Migration number reserved:** 061_create_lookup_events
**Forbidden files:**
- `packages/api/src/db/pg-base.ts` (frozen)
- `packages/shared/src/enums.ts` (Tier-1 — put intent additions in intent-classifier.ts only)
- `packages/api/src/auth/rbac.ts`
- `packages/api/src/proposals/**` (lookups bypass proposals — they're read-only; document at top of each skill)
- `packages/api/src/customers/**`, `packages/api/src/invoices/**`, `packages/api/src/estimates/**`, `packages/api/src/agreements/**`, `packages/api/src/appointments/**` (READ ONLY — query through existing repos)
- `packages/api/src/ai/agents/customer-calling/state-machine.ts` (FSM is pure; do NOT add a new state — lookups complete in `intent_capture` and re-enter)
- `packages/web/src/components/auth/**`

**Allowed files (concrete list):**
- `packages/api/src/ai/skills/lookup-appointments.ts` (new)
- `packages/api/src/ai/skills/lookup-invoices.ts` (new)
- `packages/api/src/ai/skills/lookup-balance.ts` (new)
- `packages/api/src/ai/skills/lookup-jobs.ts` (new)
- `packages/api/src/ai/skills/lookup-agreements.ts` (new)
- `packages/api/src/ai/skills/lookup-account-summary.ts` (new)
- `packages/api/src/ai/skills/__tests__/*.test.ts` (placeholders if vitest doesn't pick them up)
- `packages/api/test/ai/skills/lookup-*.test.ts` (real tests, one per skill)
- `packages/api/src/ai/orchestration/intent-classifier.ts` (modify — add 6 intents to union/array/system-prompt/parser only; do NOT refactor)
- `packages/api/src/telephony/twilio-adapter.ts` (modify — add lookup-routing branch in handleGather only; do NOT refactor unrelated paths)
- `packages/api/src/jobs/job.ts` (modify — add `findByCustomer` to interface + InMemory)
- `packages/api/src/jobs/pg-job.ts` (modify — add `findByCustomer` Pg impl)
- `packages/api/test/jobs/job-find-by-customer.test.ts` (new — tenant isolation + happy path)
- `packages/api/src/lookup-events/lookup-event.ts` (new — interface, InMemory repo)
- `packages/api/src/lookup-events/pg-lookup-event.ts` (new — Pg repo)
- `packages/api/src/lookup-events/lookup-event-service.ts` (new — record + list)
- `packages/api/test/lookup-events/lookup-event.test.ts` (new)
- `packages/api/src/db/schema.ts` (modify — add `061_create_lookup_events` ONLY)
- `packages/api/src/app.ts` (modify — wire LookupEventRepository ternary; pass into adapter wiring)
- `packages/web/src/pages/conversations/ConversationThread.tsx` (modify — add LookupEventInline rendering only; do NOT refactor existing message rendering)
- `packages/web/src/components/conversations/LookupEventInline.tsx` (new)
- `packages/web/src/components/conversations/__tests__/LookupEventInline.test.tsx` (new)

**Verification gate (single command):**
```bash
cd /home/user/Serviceos && \
  (cd packages/api && npx tsc --project tsconfig.build.json --noEmit) && \
  (cd packages/api && npm test -- -t "lookup|P11-001") && \
  (cd packages/web && npm test -- --run -t "Lookup|LookupEvent|P11-001")
```

**Pre-flight:**
- `git fetch origin && git rev-parse origin/main` succeeds.
- Migration 061 free in `packages/api/src/db/schema.ts`.

**Risk note:**
- **No FSM changes.** The plan deliberately keeps lookups inside `intent_capture` re-entry. Adding a new state would force every transition test to update. The skill returns; adapter speaks the result; agent re-prompts.
- **Money-as-cents.** Skills receive cents from repos and convert for TTS via `formatCents` (read it; do NOT modify). For TTS, `$120.50` is fine — both engines speak it correctly. Never spell out cents as bare integers.
- **Time/date rendering.** Always render in the customer's tenant timezone (read tenant settings at session start; thread through). Never echo raw ISO timestamps.
- **Tenant isolation.** Every skill MUST take `tenantId` as the first arg and pass it to the repo methods. Test by hand-crafting a cross-tenant call and asserting empty result.
- **Latency budget.** Lookup → speak loop should be < 5s. Use `Promise.all` for any per-job fan-out. The `lookup_account_summary` skill MUST run its sub-lookups in parallel.
- **Audit log volume.** Every lookup writes a row. Don't include large payloads in the row — just intent, result_status, count, summary, latency.
- **Classifier prompt drift.** Adding 6 intents bloats the system prompt. Group lookup intents in their own block with a header comment. If the prompt exceeds the model's optimal context, consider model-side mitigations in a follow-up (out of scope here).

**Implementation hints:**
1. Read `packages/api/src/ai/skills/lookup-availability.ts` first — closest existing pattern.
2. Read `packages/api/src/ai/skills/identify-caller.ts` — repo-only skill shape, no LLM.
3. Read `packages/api/src/customers/timeline-service.ts` (P9-002) for the parallel fan-out pattern.
4. Read `packages/api/src/telephony/twilio-adapter.ts` `handleGather` to find the right insertion point. Look for the existing `intent_classified` event branch.
5. Money formatting: existing `formatCents` lives somewhere — likely `packages/api/src/shared/format.ts` or similar. Find it; use it.
6. The `lookup_events` row is written by the skill itself (not the adapter) so even direct-test callers produce audit rows.

---

## P11-002 — Multilingual (Spanish)

**Wave:** 11B (after 11A merges)
**Migration number reserved:** 062_create_language_settings
**Forbidden files:**
- `packages/api/src/db/pg-base.ts` (frozen)
- `packages/shared/src/enums.ts`
- `packages/api/src/auth/rbac.ts`
- `packages/api/src/customers/customer.ts` (interface) — but you MAY add `preferredLanguage` to the entity type if needed; if so, that goes in a frozen-list-aware Tier-2 evolution. SAFER PATH: store language as a column only; don't add to the `Customer` interface — read it via a new `customers/preferences.ts` helper. **Decision:** add to `Customer` interface, justified because preferred_language is a first-class customer attribute used by voice + UI; this is an additive, optional field (Tier-2 stable-with-extensions per freeze-list).
- `packages/api/src/proposals/**`
- `packages/api/src/ai/agents/customer-calling/state-machine.ts`
- `packages/web/src/components/auth/**`

**Allowed files (concrete list):**
- `packages/api/src/ai/i18n/en.ts` (new — English catalog)
- `packages/api/src/ai/i18n/es.ts` (new — Spanish catalog)
- `packages/api/src/ai/i18n/i18n.ts` (new — `t()` helper + types)
- `packages/api/src/ai/i18n/__tests__/i18n.test.ts` (new)
- `packages/api/test/ai/i18n/i18n.test.ts` (new — catalog completeness)
- `packages/api/src/ai/orchestration/intent-classifier.ts` (modify — add Spanish system prompt examples + language_switch intent)
- `packages/api/src/ai/orchestration/language-detector.ts` (new)
- `packages/api/test/ai/orchestration/language-detector.test.ts` (new)
- `packages/api/src/ai/skills/*.ts` (modify — replace inline English with `t(key, lang, vars)` calls)
- `packages/api/src/ai/tts/tts-provider.ts` (modify — add `language` to `TtsSynthesizeInput`, wire OpenAI + ElevenLabs)
- `packages/api/src/voice/transcription-providers.ts` (modify — add language to Deepgram constructor + openSession; thread Whisper hint)
- `packages/api/src/telephony/twilio-adapter.ts` (modify — thread language; emit Spanish TwiML when applicable)
- `packages/api/src/db/schema.ts` (modify — `062_create_language_settings` ONLY)
- `packages/api/src/app.ts` (modify — wire detector + pass tenant settings to adapter)
- `packages/api/src/customers/customer.ts` (modify — add optional `preferredLanguage?: 'en'|'es'` to Customer interface — DO NOT change method signatures)
- `packages/api/src/customers/pg-customer.ts` (modify — read/write the new column)
- `packages/api/src/leads/lead.ts` + `pg-lead.ts` (modify — same)
- `packages/web/src/pages/settings/LanguageSettings.tsx` (new)
- `packages/web/src/components/settings/__tests__/LanguageSettings.test.tsx` (new)
- `packages/web/src/components/customers/LanguageBadge.tsx` (new)
- `packages/web/src/components/customers/__tests__/LanguageBadge.test.tsx` (new)
- `packages/web/src/api/settings.ts` (modify or new — add language settings endpoints)
- `packages/web/src/pages/customers/CustomerDetail.tsx` (modify — add badge + edit dropdown only)
- `packages/web/src/pages/leads/LeadDetail.tsx` (modify — same)

**Verification gate (single command):**
```bash
cd /home/user/Serviceos && \
  (cd packages/api && npx tsc --project tsconfig.build.json --noEmit) && \
  (cd packages/api && npm test -- -t "i18n|language|multilingual|P11-002") && \
  (cd packages/web && npm test -- --run -t "Language|Multilingual|P11-002")
```

**Pre-flight:**
- P11-001 merged on origin/main (so the skill files exist to translate).
- Migration 062 free.

**Risk note:**
- **Catalog completeness must be enforced at compile time.** Use a single `TranslationKey` union type that both `en.ts` and `es.ts` satisfy via `Record<TranslationKey, string>`. Missing key in `es.ts` = TypeScript error.
- **OpenAI tts-1 multilingual.** Verify by passing language code; the model handles it. ElevenLabs requires `eleven_multilingual_v2` model AND a multilingual voice. Don't ship without testing both providers in dev.
- **Deepgram URL.** Construction is in `transcription-providers.ts:318`. Only the URL changes; protocol stays the same.
- **Twilio voice mapping.** Use `Polly.Mia-Neural` (Mexican Spanish, neural quality) as the default Spanish voice. English default stays `Polly.Joanna`. Make tenant-overridable.
- **Mid-call language switch.** The classifier already runs every turn. Add a small pre-pass that checks for switch phrases before the main intent classification. Don't try to be clever — explicit phrases only.
- **Spanish dispatcher fallback.** If `spanish_dispatcher_user_ids` is empty and call is Spanish → escalate to default rotation but log a warning that dispatcher may not speak Spanish.
- **Spanish lead from Twilio.** When language detection fires for an unknown caller, the existing `find-or-create-lead` runs. Pass detected language to it.
- **Money/dates in Spanish.** "$120.50" reads as "ciento veinte dólares con cincuenta centavos" in Polly.Mia. Dates rendered as Spanish locale ("martes a las dos de la tarde"). The TTS handles this if the source string is Spanish.

**Implementation hints:**
1. Read freeze-list Tier-2 — entity create schemas are stable-with-extensions; adding `preferredLanguage` to `Customer` is permitted.
2. Read `packages/api/src/voice/transcription-providers.ts:311-379` (Deepgram) before modifying.
3. The i18n catalog is small at first — start with maybe 20 keys (greetings, confirmations, lookup templates, errors). Expand as new strings appear.
4. OpenAI TTS supports language via the input text alone; you don't need a `language` API param — but threading the field through the codebase is still required so the right voice gets chosen for ElevenLabs.
5. Customer/Lead `preferredLanguage` column: `TEXT CHECK (preferred_language IN ('en','es'))`, nullable.
6. UI: don't try to translate the WHOLE web app — only the voice-facing strings. Web UI stays English in this story.

---

## P11-006 — UI create forms — Invoice / Estimate / Job

**Wave:** 11C-1 (after 11A merges; can run parallel with 11B)
**Migration number reserved:** none
**Forbidden files:**
- `packages/api/**` (this is UI-only)
- `packages/shared/**`
- `packages/web/src/components/auth/**`
- `packages/web/src/hooks/useListQuery.ts`
- `packages/web/src/pages/invoices/InvoiceDetail.tsx`, `InvoiceList.tsx`
- `packages/web/src/pages/estimates/EstimateDetail.tsx`, `EstimateList.tsx`
- `packages/web/src/pages/jobs/JobDetail.tsx`, `JobList.tsx`
- `packages/web/src/pages/customers/**`

**Allowed files (concrete list):** as listed in the story.

**Verification gate (single command):**
```bash
cd /home/user/Serviceos && \
  (cd packages/api && npx tsc --project tsconfig.build.json --noEmit) && \
  (cd packages/web && npm test -- --run -t "InvoiceCreate|EstimateCreate|JobCreate|LineItemEditor|CustomerPicker|P11-006")
```

**Pre-flight:**
- P11-001 merged on origin/main (clean app.ts editing surface — though this story doesn't touch app.ts, it's just hygiene).

**Risk note:**
- **Money in cents.** UI reads/writes dollars; payloads are cents. `LineItemEditor` MUST do the conversion at the edge — never let cents leak into the input field.
- **Customer picker.** Debounce 300ms. Cap suggestions at 10. Use existing `apiClient` (read it).
- **Form validation.** Mirror server Zod schemas. Don't reinvent.
- **No list-page edits.** Don't add "+ New" buttons in this story; user can navigate via direct URL. List page CTAs are a follow-up.

**Implementation hints:**
1. Read the existing `LeadCreate.tsx` (P9-001) for form structure.
2. Read `packages/web/src/lib/apiClient.ts` for the request pattern.
3. Read existing detail pages to match styling.

---

## P11-007 — UI edit forms

**Wave:** 11C-2 (after P11-006 merges)
**Forbidden files:** packages/api/**, packages/shared/**, auth components.
**Allowed files (concrete list):** as listed in the story.

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  (cd packages/web && npm test -- --run -t "CustomerEdit|AppointmentEdit|Reschedule|Cancel|Reassign|P11-007")
```

**Risk note:**
- Reuse `LineItemEditor` from P11-006 — do NOT duplicate.
- Cancellation preserves history (PATCH status, never DELETE).
- The detail-page touches are surgical: find the existing line-item display and wrap with toggle. Don't refactor.

---

## P11-008 — UI compose — Notes / Send / Message

**Wave:** 11C-3 (after P11-006 merges; parallel with P11-007)
**Forbidden files:** packages/api/**, packages/shared/**, auth components.
**Allowed files (concrete list):** as listed in the story.

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  (cd packages/web && npm test -- --run -t "NotesComposer|SendInvoice|SendEstimate|MessageComposer|P11-008")
```

**Risk note:**
- Respect tenant SMS/email consent flags before submitting. Read existing send paths to find where consent is checked.
- All composers should clear the input on success and refresh the parent view.

---

## Universal pre-flight checks

Same as `p0-dispatch-addendum.md`. Apply to every Phase 11 story before launching the dispatch agent.

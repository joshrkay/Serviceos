# Phase 11 — Voice Parity (Lookup + Multilingual + UI Catch-up)

> **5 stories** | Closes the asymmetry between voice and visual surfaces; adds Spanish

---

## Purpose

Today the UI can read everything but creates almost nothing. The voice agent can create 14 mutation types via proposals but cannot *answer* a single question. Phase 11 closes both halves AND adds Spanish-language support — the missing language for HVAC/plumbing/lawn/cleaning service businesses.

The user principle: **every feature must be both voice and visual, or it isn't done.**

## Exit Criteria

- A caller can ask "what's my balance / when's my next appointment / am I on the maintenance plan" and get a spoken answer.
- A Spanish-speaking caller is detected and served in Spanish end-to-end (greeting, intents, lookups, escalation).
- An owner can create invoices/estimates/jobs from the UI and edit/send/note from detail pages — matching every voice-side action.

## Gap Summary

| ID | Title | Size | Layer | AI Build | Human Review | Dependencies |
|----|-------|------|-------|----------|--------------|-------------|
| P11-001 | Voice lookup skill family + intent routing + audit log | M | Voice | Medium | Heavy | none (P9 entities exist) |
| P11-002 | Multilingual (Spanish) — STT/TTS/classifier/i18n catalog + lang detection | L | Voice | Medium | Heavy | P11-001 |
| P11-006 | UI create forms — Invoice / Estimate / Job | M | UI | High | Moderate | none |
| P11-007 | UI edit forms — Customer / Appointment (resched/cancel/reassign) / line items | M | UI | High | Moderate | P11-006 |
| P11-008 | UI compose — Notes / Send-Invoice / Send-Estimate / Send-Message | S | UI | High | Light | P11-006 |

---

## Story Specifications

### P11-001 — Voice lookup skill family + intent routing + audit log

> **Size:** M | **Layer:** Voice | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** none (consumes existing P9-001..003 entities)

**Allowed files:** `packages/api/src/ai/skills/lookup-appointments.ts, packages/api/src/ai/skills/lookup-invoices.ts, packages/api/src/ai/skills/lookup-balance.ts, packages/api/src/ai/skills/lookup-jobs.ts, packages/api/src/ai/skills/lookup-agreements.ts, packages/api/src/ai/skills/lookup-account-summary.ts, packages/api/src/ai/skills/__tests__/**, packages/api/test/ai/skills/**, packages/api/src/ai/orchestration/intent-classifier.ts, packages/api/src/telephony/twilio-adapter.ts, packages/api/src/jobs/job.ts, packages/api/src/jobs/pg-job.ts, packages/api/src/jobs/__tests__/**, packages/api/test/jobs/**, packages/api/src/db/schema.ts (migration 061 only), packages/api/src/app.ts (wiring only), packages/api/src/lookup-events/**, packages/api/test/lookup-events/**, packages/web/src/pages/conversations/ConversationThread.tsx (add lookup-event rendering only), packages/web/src/components/conversations/LookupEventInline.tsx, packages/web/src/components/conversations/__tests__/LookupEventInline.test.tsx`

**Build prompt:** Build six new voice lookup skills + an audit log + UI surfacing.

(1) **Skill files** in `packages/api/src/ai/skills/`. Mirror the shape of `lookup-availability.ts` (the closest existing pattern). Each takes `(input: { tenantId, customerId, ... })` and returns `{ status: 'found'|'none'|'error', summary: string (TTS-ready), data: ... }`. The `summary` is the string the TTS layer reads to the caller. Money rendered via `formatCents` adapted for spoken output (`"one hundred twenty dollars and fifty cents"` or `"$120.50"` based on engine — start with the latter, both engines speak it correctly). All times rendered in the customer's tenant timezone.

   - `lookup-appointments.ts` — `lookup_appointments({tenantId, customerId, dateFrom?, dateTo?, limit=3})`. Aggregates via `jobsRepo.findByCustomer` → `appointmentRepo.findByJob` per job. Returns next N upcoming + technician name + scheduled time.
   - `lookup-invoices.ts` — `lookup_invoices({tenantId, customerId, status?})`. Default to status='sent'|'overdue' (i.e. open). Returns count + total + per-invoice number/amount/due.
   - `lookup-balance.ts` — `lookup_balance({tenantId, customerId})`. Sum unpaid invoices. Returns `{ balanceCents, openCount, oldestDueDate }`.
   - `lookup-jobs.ts` — `lookup_jobs({tenantId, customerId, recentLimit=3})`. Recent jobs with status, summary line.
   - `lookup-agreements.ts` — `lookup_agreements({tenantId, customerId})`. Active agreements with `nextRunAt`.
   - `lookup-account-summary.ts` — `lookup_account_summary({tenantId, customerId})`. Two-sentence digest: "You have N open invoices totaling X and M upcoming appointments. Want details on either?" Calls the other lookups internally via Promise.all.

(2) **Add `findByCustomer`** to `JobRepository` (interface + InMemory + Pg). Additive. Method: `findByCustomer(tenantId, customerId, opts?: { limit?: number, includeArchived?: boolean }) → Job[]`. Use `WHERE tenant_id = $1 AND customer_id = $2` (RLS still enforces).

(3) **Intent classifier extensions** — add 6 new `IntentType` variants (`lookup_appointments`, `lookup_invoices`, `lookup_balance`, `lookup_jobs`, `lookup_agreements`, `lookup_account_summary`) to the union, the `SUPPORTED_INTENTS` array, and the system prompt example block. Each prompt example MUST list at least 5 phrasing variants (English only in this story). Keep confidence threshold at 0.75; lookups are read-only so misclassification cost is low.

(4) **Adapter wiring** — in `twilio-adapter.ts`, in the `handleGather` path, when `intentType` starts with `lookup_`, route to the corresponding skill instead of the proposal-draft path. The skill result's `summary` becomes the next TTS utterance. After the response, re-prompt: "Anything else I can help you with?" — re-enter `intent_capture`.

(5) **Audit log** — migration `061_create_lookup_events` table: `id, tenant_id, session_id (uuid), customer_id (uuid, nullable), intent (text), result_status (text), result_count (int), summary (text), latency_ms (int), created_at`. RLS by tenant. Repo + service in `packages/api/src/lookup-events/` following Phase 9 conventions.

(6) **UI surfacing** — in `ConversationThread.tsx`, render `lookup_event` rows inline as system messages using a new `LookupEventInline.tsx` component: small icon, "Customer asked about appointments → 2 results" plus expandable JSON. Pull events via the existing conversation-events endpoint (the linkage is by `session_id` ↔ `conversation_id` if those tables relate; if not, return lookup events alongside messages from a new sub-endpoint).

**Review prompt:** Verify every skill returns deterministic shape for empty/single/multi result. Verify TTS-ready `summary` strings don't contain raw cents or ISO timestamps. Verify `findByCustomer` is RLS-safe and tested for tenant isolation. Verify the classifier system prompt has at least 5 phrasings per new intent. Verify the lookup-event row is written for every voice lookup (success or error). Verify the conversation thread doesn't break when there are zero lookup events.

**Automated checks:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd packages/api && npm test -- -t "lookup|P11-001"
cd packages/web && npm test -- --run -t "Lookup|LookupEvent|P11-001"
```

**Required tests:**
- [ ] Each lookup skill: empty / single / multi-result paths
- [ ] `lookup_account_summary` aggregates from sub-lookups
- [ ] `formatCents` for TTS produces friendly output for $0, $120, $120.50, $1,000.00
- [ ] Intent classifier returns the right `lookup_*` intent for 5+ phrasings each
- [ ] `JobRepository.findByCustomer` tenant isolation
- [ ] `lookup_events` row written per voice lookup
- [ ] ConversationThread renders LookupEventInline for events; empty list doesn't crash

---

### P11-002 — Multilingual (Spanish) — STT/TTS/classifier/i18n catalog + lang detection

> **Size:** L | **Layer:** Voice | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P11-001

**Allowed files:** `packages/api/src/ai/i18n/**, packages/api/src/ai/orchestration/intent-classifier.ts, packages/api/src/ai/orchestration/language-detector.ts, packages/api/src/ai/skills/**, packages/api/src/ai/tts/tts-provider.ts, packages/api/src/voice/transcription-providers.ts, packages/api/src/telephony/twilio-adapter.ts, packages/api/src/db/schema.ts (migration 062 only), packages/api/src/app.ts (wiring only), packages/api/test/ai/i18n/**, packages/api/test/ai/orchestration/**, packages/api/test/ai/skills/**, packages/web/src/pages/settings/LanguageSettings.tsx, packages/web/src/components/settings/__tests__/LanguageSettings.test.tsx, packages/web/src/components/customers/LanguageBadge.tsx, packages/web/src/components/customers/__tests__/LanguageBadge.test.tsx, packages/web/src/api/settings.ts, packages/web/src/pages/customers/CustomerDetail.tsx (add language badge + edit only), packages/web/src/pages/leads/LeadDetail.tsx (add language badge + edit only)`

**Build prompt:** Add Spanish language support across the voice stack and UI metadata.

(1) **Migration `062_create_language_settings`** — additive ALTERs:
   - `tenant_settings`: add `default_language TEXT NOT NULL DEFAULT 'en' CHECK (default_language IN ('en','es'))`, `tts_voice_en TEXT`, `tts_voice_es TEXT`, `auto_detect_language BOOLEAN NOT NULL DEFAULT true`, `spanish_dispatcher_user_ids UUID[]` (Postgres array)
   - `customers`: add `preferred_language TEXT CHECK (preferred_language IN ('en','es'))`
   - `leads`: add `preferred_language TEXT CHECK (preferred_language IN ('en','es'))`
   If `tenant_settings` doesn't exist as a table, document the alternate location (likely a JSON column on tenants); discover by reading schema.ts first.

(2) **i18n catalog** — `packages/api/src/ai/i18n/en.ts`, `es.ts`, `i18n.ts` exporting `t(key: TranslationKey, lang: 'en'|'es', vars?: Record<string,string>)`. Pure function, no library. Typed key union prevents drift between catalogs. Include keys for: greeting, identification prompts, intent confirmation, escalation, all six lookup summary templates ("you have {{count}} open invoices totaling {{amount}}"), error messages, language-switch acknowledgement, recording disclosure.

(3) **Provider extensions:**
   - `TtsSynthesizeInput` gains `language: 'en' | 'es'` (default 'en'). OpenAI tts-1 path: pass language code in input string (it auto-handles). ElevenLabs path: switch model to `eleven_multilingual_v2` and select voice per language. NoopTtsProvider: no-op.
   - `WhisperTranscribeOptions.language` already exists — thread it through from the adapter.
   - `DeepgramStreamingProvider` constructor + `openSession()` accept `language: 'en'|'es'`; rebuild WebSocket URL with `language=es` when Spanish.

(4) **Language detector** — `language-detector.ts` exposes `detectLanguage({ tenantSettings, customer, firstUtteranceText? }) → 'en'|'es'`. Resolution order: customer.preferredLanguage > Whisper auto-detect (run without lang hint on first utterance) > tenant.defaultLanguage > 'en'. Cache result on session.

(5) **Mid-call language switch** — add a small classifier pass alongside intent classification: if `text` contains "english please" / "in english" → switch to en; if `hablo español` / `en español` → switch to es. Acknowledge with the i18n catalog phrase, then re-prompt.

(6) **Twilio adapter wiring** — pass `language` to `<Gather language="es-ES">` and `<Say voice="Polly.Mia-Neural">` (or tenant-configured voice) in TwiML. Pass language to STT provider on every transcribe call. Pass language to TTS on every synthesize.

(7) **Translate skill summaries** — every skill from P11-001 must produce TTS strings via `t(key, lang, vars)`. The `summary` field becomes a key-vars pair. Inline English strings are forbidden in skills after this story.

(8) **Auto-create Spanish lead** — when an unknown caller speaks Spanish and `find-or-create-lead` runs, set `lead.preferredLanguage = 'es'`.

(9) **Spanish-dispatcher escalation** — in `escalate-to-human`, if session.language='es' and `tenant.spanish_dispatcher_user_ids` is set, prefer those users in rotation lookup.

(10) **UI:**
   - `LanguageSettings.tsx` (settings page panel): default-language radio, voice picker per language with sample-and-play preview, auto-detect toggle, Spanish-dispatcher multi-select.
   - `LanguageBadge.tsx`: small flag + label ("Speaks Spanish"), reused on customer + lead detail.
   - On `CustomerDetail` and `LeadDetail` (additive only): show badge, allow inline edit (dropdown).

**Review prompt:** Verify every English string in the skill family was migrated to the i18n catalog (zero hardcoded skill strings). Verify `t()` is type-safe and missing keys cause compile errors. Verify Whisper language hint is passed end-to-end. Verify Deepgram language URL changes when language='es'. Verify TTS produces Spanish audio (mock the provider in tests; assert the language param). Verify mid-call switch flips session and acknowledges in target language. Verify Spanish dispatcher rotation. Test edge case: Spanish caller, tenant has no Spanish voice configured → fallback to OpenAI default + warning logged.

**Automated checks:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
cd packages/api && npm test -- -t "i18n|language|multilingual|P11-002"
cd packages/web && npm test -- --run -t "Language|Multilingual|P11-002"
```

**Required tests:**
- [ ] `t()` returns correct Spanish for every key
- [ ] Catalog completeness — every English key has a Spanish counterpart (compile-time)
- [ ] Whisper detection returns 'es' for Spanish audio sample (mock the provider)
- [ ] TTS provider receives `language` param; emits Spanish-tagged audio
- [ ] Deepgram URL contains `language=es` when Spanish
- [ ] Twilio TwiML uses `<Say voice="Polly.Mia-Neural">` for Spanish
- [ ] Mid-call switch: "english please" flips lang back to en
- [ ] Spanish dispatcher prioritized in escalation when session is Spanish
- [ ] Auto-created lead from Spanish caller has preferred_language='es'
- [ ] LanguageSettings UI saves all four settings
- [ ] LanguageBadge renders for Spanish customer

---

### P11-006 — UI create forms — Invoice / Estimate / Job

> **Size:** M | **Layer:** UI | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** none

**Allowed files:** `packages/web/src/pages/invoices/InvoiceCreate.tsx, packages/web/src/pages/estimates/EstimateCreate.tsx, packages/web/src/pages/jobs/JobCreate.tsx, packages/web/src/pages/invoices/__tests__/InvoiceCreate.test.tsx, packages/web/src/pages/estimates/__tests__/EstimateCreate.test.tsx, packages/web/src/pages/jobs/__tests__/JobCreate.test.tsx, packages/web/src/components/invoices/InvoiceForm.tsx, packages/web/src/components/estimates/EstimateForm.tsx, packages/web/src/components/jobs/JobForm.tsx, packages/web/src/components/forms/LineItemEditor.tsx, packages/web/src/components/forms/__tests__/LineItemEditor.test.tsx, packages/web/src/components/forms/CustomerPicker.tsx, packages/web/src/components/forms/__tests__/CustomerPicker.test.tsx, packages/web/src/routes.ts (add 3 routes only)`

**Build prompt:** Build the three missing create forms. Each follows the same pattern: search/pick customer → fill form → submit → route to detail page.

(1) **Shared form primitives:**
   - `LineItemEditor.tsx` — table of editable line items: description, quantity, unit price (entered as dollars, stored as cents), line total (computed). Add/remove rows. Emits `LineItem[]` with `priceCents`.
   - `CustomerPicker.tsx` — typeahead search calling `GET /api/customers?search=...&limit=10`. Selects a customer; shows display name + primary phone.

(2) **Per-form pages:**
   - `InvoiceCreate.tsx` — customer picker, optional job picker (filtered to selected customer), line items, due-date picker. POST to `/api/invoices` (existing endpoint). Route `/invoices/new`.
   - `EstimateCreate.tsx` — customer picker, optional job picker, line items, expiry-date picker. POST to `/api/estimates`. Route `/estimates/new`.
   - `JobCreate.tsx` — customer picker, location picker (filtered to selected customer's locations), summary field, priority dropdown, problem description. POST to `/api/jobs`. Route `/jobs/new`.

(3) **Wire routes** in `routes.ts` (this is the ONLY file outside `pages/`/`components/` allowed). Mount `/invoices/new`, `/estimates/new`, `/jobs/new`.

(4) **List page CTAs** — DO NOT modify existing list pages in this story. Note in PR description that the user will need to add a "+ New" button via a follow-up; the routes will work via direct URL in the meantime.

**Review prompt:** Verify all money is entered in dollars and submitted in cents (no float drift). Verify required-field validation client-side mirrors the server Zod schema. Verify the customer picker debounces (300ms) to avoid hammering search. Verify on success the page routes to the new entity's detail. Verify form errors render inline next to the offending field.

**Automated checks:**
```bash
cd packages/web && npm test -- --run -t "InvoiceCreate|EstimateCreate|JobCreate|LineItemEditor|CustomerPicker|P11-006"
```

**Required tests:**
- [ ] LineItemEditor: add/remove rows; total recomputes
- [ ] LineItemEditor: dollars entered, cents in payload (no float drift on $123.45)
- [ ] CustomerPicker debounces search; selects customer
- [ ] InvoiceCreate submits with cents, routes on success
- [ ] EstimateCreate same
- [ ] JobCreate validates summary required
- [ ] Form errors render inline

---

### P11-007 — UI edit forms — Customer / Appointment / Line items

> **Size:** M | **Layer:** UI | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P11-006 (LineItemEditor reuse)

**Allowed files:** `packages/web/src/pages/customers/CustomerEdit.tsx, packages/web/src/pages/customers/__tests__/CustomerEdit.test.tsx, packages/web/src/pages/appointments/AppointmentEdit.tsx, packages/web/src/pages/appointments/__tests__/AppointmentEdit.test.tsx, packages/web/src/pages/invoices/InvoiceDetail.tsx (add line-item edit only — find the existing line-item display and wrap with edit toggle), packages/web/src/pages/estimates/EstimateDetail.tsx (same), packages/web/src/components/appointments/RescheduleDialog.tsx, packages/web/src/components/appointments/CancelDialog.tsx, packages/web/src/components/appointments/ReassignDialog.tsx, packages/web/src/components/appointments/__tests__/**, packages/web/src/routes.ts (add 2 routes only)`

**Build prompt:** Wire the stubbed edit buttons.

(1) **CustomerEdit.tsx** — same fields as `CustomerCreate` (firstName, lastName, companyName, phones, email, preferredChannel, smsConsent, notes). Loads existing customer, PATCH on save. Route `/customers/:id/edit`.

(2) **AppointmentEdit.tsx** + dialogs — three actions on the existing AppointmentDetail page:
   - **Reschedule** → `RescheduleDialog`: date+time picker → POST to existing endpoint OR PATCH `/api/appointments/:id` (whichever the API exposes; discover by reading routes/appointments.ts)
   - **Cancel** → `CancelDialog`: confirm + reason → PATCH status='cancelled'
   - **Reassign** → `ReassignDialog`: user picker → PATCH `assignedUserId`

(3) **Line-item editing on InvoiceDetail/EstimateDetail** — wrap the existing line-item display with an "Edit" toggle. Reuse `LineItemEditor` from P11-006. Save = PATCH to the entity endpoint. Read existing detail pages first to find the right insertion point; add only the edit toggle and the editor component mount, don't refactor the surrounding markup.

**Review prompt:** Verify edits PATCH (not POST). Verify cancellation preserves history (sets status, doesn't delete). Verify line-item edits update totals correctly. Verify dialogs close on success.

**Automated checks:**
```bash
cd packages/web && npm test -- --run -t "CustomerEdit|AppointmentEdit|Reschedule|Cancel|Reassign|P11-007"
```

**Required tests:**
- [ ] CustomerEdit loads + saves
- [ ] RescheduleDialog updates time
- [ ] CancelDialog requires reason; sets status
- [ ] ReassignDialog updates user
- [ ] Line-item editing on invoice updates totals

---

### P11-008 — UI compose — Notes / Send / Message

> **Size:** S | **Layer:** UI | **AI Build:** High | **Human Review:** Light

**Dependencies:** P11-006

**Allowed files:** `packages/web/src/components/notes/NotesComposer.tsx, packages/web/src/components/notes/__tests__/NotesComposer.test.tsx, packages/web/src/components/invoices/SendInvoiceButton.tsx, packages/web/src/components/estimates/SendEstimateButton.tsx, packages/web/src/components/conversations/MessageComposer.tsx, packages/web/src/pages/conversations/ConversationThread.tsx (add MessageComposer mount only), packages/web/src/pages/customers/CustomerDetail.tsx (add NotesComposer in notes section only), packages/web/src/pages/jobs/JobDetail.tsx (same), packages/web/src/pages/invoices/InvoiceDetail.tsx (add SendInvoiceButton + NotesComposer), packages/web/src/pages/estimates/EstimateDetail.tsx (add SendEstimateButton + NotesComposer)`

**Build prompt:**

(1) **NotesComposer.tsx** — textarea + submit; props: `entityType, entityId`. POST to existing `/api/notes`. Mount on customer/job/invoice/estimate detail pages within their existing notes section.

(2) **SendInvoiceButton / SendEstimateButton** — opens a dialog: choose channel (sms/email), confirm recipient, send. Calls existing send endpoints (discover via routes/invoices.ts and routes/estimates.ts).

(3) **MessageComposer.tsx** — for ConversationThread: text input + send button. POST to whatever the existing send-message endpoint is.

**Review prompt:** Verify each composer respects tenant SMS/email consent flags before submitting. Verify success closes the dialog and refreshes the parent view.

**Automated checks:**
```bash
cd packages/web && npm test -- --run -t "NotesComposer|SendInvoice|SendEstimate|MessageComposer|P11-008"
```

**Required tests:**
- [ ] NotesComposer submits; textarea clears
- [ ] SendInvoiceButton dialog flow
- [ ] SendEstimateButton dialog flow
- [ ] MessageComposer sends and clears

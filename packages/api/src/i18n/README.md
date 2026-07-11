# i18n — three locations, three jobs (do not consolidate blindly)

There are three `i18n` directories in `packages/api/src`. Each is live
(verified by grepping production call sites, 2026-07), and they exist
separately on purpose:

## 1. `i18n/` (this directory) — language *resolution*

`resolve-language.ts` answers one question: **which language should this
customer-facing message be in?** Resolution order is always
`customer.preferredLanguage ?? tenant.defaultLanguage ?? 'en'`, narrowed
from a free-form BCP-47 string (`'es-MX'` → `'es'`) down to a supported
`Language`. It wraps the voice-stack `detectLanguage` resolver so
non-voice surfaces (comms, notifications, workers) get the exact same
resolution order as the voice path.

It contains no translated strings — it is pure decision logic. It lives
outside `ai/` specifically so the notifications layer can depend on it
without pulling in the AI module graph.

Callers: `notifications/transactional-comms-service.ts`,
`notifications/send-service.ts`, `workers/thank-you-sms-worker.ts`,
`workers/feedback-send.ts`.

## 2. `ai/i18n/` — voice-stack translation catalog + shared engine

`i18n.ts` defines `makeTranslator()`, the shared interpolation/fallback
engine (`{{var}}` substitution, EN-fallback-on-missing-key, compile-time
key parity between the EN and ES catalogs via `Record<keyof EN, string>`).
`en.ts` / `es.ts` are the voice-stack (TTS) string catalogs — what the
agent says on a call.

This is the source-of-truth engine: `notifications/i18n` imports
`makeTranslator` from here rather than duplicating the interpolation
logic.

Callers: `telephony/twilio-adapter.ts`, `routes/telephony.ts`,
`notifications/templates.ts`, `notifications/transactional-comms-service.ts`,
`settings/settings.ts`.

## 3. `notifications/i18n/` — notifications translation catalog

`en.ts` / `es.ts` here are a **separate catalog** from the voice one —
SMS/email/push copy, not spoken TTS strings. Voice and notification copy
diverge in register and length (a voice prompt reads naturally out loud;
an SMS is terse and may include links/formatting), so they are
maintained as separate key sets. `index.ts` builds its translator with
the *same* `makeTranslator` engine from `ai/i18n/i18n.ts` (see engine
note above) so both catalogs interpolate and fall back identically —
only the catalog content differs.

Callers: `workers/feedback-send.ts`.

## Why not merge them

- `i18n/` is resolution logic with zero strings; the other two are
  string catalogs with zero resolution logic. Merging would mix two
  different concerns into one module.
- `ai/i18n/` and `notifications/i18n/` are separate catalogs (voice vs.
  written copy) that already share their engine code (`makeTranslator`).
  Merging the catalogs would force one key set to serve two registers of
  copy, which is how the historical drift these modules were built to
  avoid gets reintroduced.
- If a fourth surface needs translated strings, prefer adding a new
  catalog next to `notifications/i18n/` that reuses `makeTranslator` from
  `ai/i18n/i18n.ts`, not folding it into an existing catalog.

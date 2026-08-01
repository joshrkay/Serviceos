---
module: brand-voice
tags: [N-011, P4-015, brand-voice, tenant-settings, onboarding, confidence-markers, N-002]
problem_type: feature-design
status: draft
story: N-011 / P4-015
effort: M
---

# Design — Brand-Voice Configurator (N-011 / P4-015)

**Scope:** design document only. No product code. This is the smallest of the
three verification-gap features because the backend storage slot already
exists; the gap is UI + versioning + utterance tagging + deviation detection.

PRD source of truth: `docs/PRD.md:878` (N-011 story) and the data-model summary
`docs/PRD.md:1136-1137` (`tenants.brand_voice` JSONB "locked tone profile" +
`brand_voice_versions` "History + rollback").

---

## 1. Current state vs N-011 gap (with file:line)

### What exists

- **Storage column.** Migration `110_tenant_settings_brand_voice`
  (`packages/api/src/db/schema.ts:2835-2838`) adds
  `tenant_settings.brand_voice JSONB NOT NULL DEFAULT '{}'`. It is a column on
  `tenant_settings`, **not** on `tenants` as the PRD data-model summary says
  (`docs/PRD.md:1136` reads `tenants.brand_voice`) — a doc/impl naming drift to
  note, not re-home.
- **Typed shape (5 fields, not 6).** `BrandVoiceSettings`
  (`packages/api/src/settings/settings.ts:156-168`): `formality`
  (`'casual'|'professional'`), `pronoun` (`'we'|'i'`), `vibe_words: string[]`,
  `business_name`, `banned_phrases: string[]`. Exposed on `TenantSettings`
  (`settings.ts:410`) and `UpdateSettingsInput` (`settings.ts:594`).
- **Read path.** `readToneFromSettings(settings)`
  (`packages/api/src/ai/brand-voice/composer.ts`) defensively parses the JSONB
  into `BrandVoiceTone` (`packages/api/src/ai/brand-voice/prompts.ts:46-60`).
- **Generation chokepoint.** `composeBrandVoiceMessage`
  (`composer.ts:215`) — single entry point that pulls tone, builds the
  `brand_voice_v1` prompt, routes through the LLM gateway, enforces `maxChars`
  and `enforceBannedPhrases` in code, and returns
  `{ text, promptVersionId }` (`ComposeBrandVoiceResult`).
- **Banned-phrase enforcement + a latent deviation signal.**
  `enforceBannedPhrases` (`composer.ts`) strips banned phrases post-generation
  and `deps.logger?.warn('brand-voice: stripped banned phrase(s)…')` when
  `removed.length > 0`. This warn is the natural deviation hook (see §5).
- **Consumers (utterance producers).**
  - `packages/api/src/scheduling/reschedule/customer-message-draft.ts:49`
    (`tech_reschedule_customer_sms`)
  - `packages/api/src/sms/recovery/recovery-composer.ts:66`
    (`dropped_call_recovery_sms`)
  - `packages/api/src/app.ts:5052` (`digest_narrative`)
  - Review responses via `SettingsBrandVoiceLoader`
    (`packages/api/src/reputation/settings-brand-voice-loader.ts`), which
    renders tone + a `signoff` derived from `business_name` for the
    `review_public_response` / `review_private_followup` draft path.
- **Intents.** `BRAND_VOICE_INTENTS` (`prompts.ts:22-28`): the five above.

### What is missing (the N-011 acceptance gaps)

| N-011 acceptance criterion (`docs/PRD.md:900-906`) | State |
|---|---|
| Onboarding captures all **six** fields | **Missing.** No onboarding step; onboarding v2 steps are Identity/Phone/Pack/AiCheck/Billing/TestCall (`packages/web/src/components/onboarding/v2/steps/`). No brand-voice capture. |
| Settings edit surface | **Missing.** No brand-voice sheet under `packages/web/src/components/settings/`; `BusinessProfileSheet.tsx` does not touch it. Nothing in `packages/web` writes `brandVoice`. |
| Six fields modeled | **Partial.** Only 5 keys, and `formality` is 2-valued vs the PRD's 3-valued register; **no `opening_lines`, no `persona_name`, no first-class `signoff`.** |
| Every AI message tagged with brand-voice **version** | **Missing.** `ComposeBrandVoiceResult.promptVersionId` is the *prompt* version (`brand_voice_v1`), not the tenant's config version. No version counter exists. |
| Deviation triggers a confidence marker (per N-002) | **Missing.** The `enforceBannedPhrases` warn is dropped to logs; never mapped to a `_meta` confidence marker. |
| Changes audit-logged | **Missing.** No brand-voice audit event; `updateSettings` (`settings.ts:908`) does not audit this field. |
| "Locked after onboarding, editable only via explicit web action + re-validate + 15-min cool-down" | **Missing entirely.** No lock, no cool-down, no re-validate. |

---

## 2. Data model

### 2a. `brand_voice` JSONB shape — the six fields

Extend `BrandVoiceSettings` (`settings.ts:156`) to the PRD's six fields.
Preserve back-compat with the shipped 5-key shape (correction-loop
`banned_phrases` and review-response reads must keep working).

```ts
export interface BrandVoiceSettings {
  // 1. Register (PRD: formal / friendly / casual). Supersedes `formality`.
  register?: 'formal' | 'friendly' | 'casual';
  // 2. Preferred opening lines (rotated/sampled by the composer).
  opening_lines?: string[];
  // 3. Sign-off (first-class; today only derived from business_name).
  signoff?: string;
  // 4. Banned phrases (EXISTS — correction-loop owned, do not break).
  banned_phrases?: string[];
  // 5. Shop persona name, e.g. "M&R Mechanical's office".
  persona_name?: string;
  // 6. Self-reference pronoun (retained; used by renderToneAuthority).
  pronoun?: 'we' | 'i';

  // --- retained legacy keys, mapped forward, NOT surfaced in new UI ---
  formality?: 'casual' | 'professional'; // compat: read if `register` absent
  vibe_words?: string[];
  business_name?: string; // compat: signoff fallback

  // --- versioning stamp (mirrors brand_voice_versions.version) ---
  version?: number;      // monotonic; 0/undefined = never configured
  locked?: boolean;      // true once onboarding completes the field
  updated_at?: string;   // ISO; cool-down anchor (see §3)
}
```

**Register compat mapping** (in `readToneFromSettings`): if `register`
absent, map legacy `formality` → `'friendly'` (casual) / `'formal'`
(professional). `renderToneAuthority` (`prompts.ts`) gains an `opening_lines`
and `persona_name` clause; the persona name replaces the generic "service
business" self-description in the tone-authority block.

> **Owner-decision note on the "six":** the PRD build prompt lists five named
> fields (register, opening lines, sign-off, banned phrases, persona name) but
> the acceptance criterion says "all six." This design counts `pronoun` as the
> sixth (already in code and load-bearing in `renderToneAuthority`). Confirm
> that mapping or name the intended sixth field.

### 2b. `brand_voice_versions` history/rollback table

New table per `docs/PRD.md:1137`. Append-only snapshots for history + rollback
and to give every utterance a stable version to cite.

```sql
CREATE TABLE IF NOT EXISTS brand_voice_versions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  version       INTEGER NOT NULL,          -- monotonic per tenant, starts at 1
  snapshot      JSONB NOT NULL,            -- full BrandVoiceSettings at bump time
  changed_by    UUID,                      -- users.id (null = onboarding/system)
  change_reason TEXT,                      -- 'onboarding' | 'web_edit' | 'rollback'
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, version)
);
-- RLS: tenant_isolation policy + FORCE ROW LEVEL SECURITY (match schema.ts
-- conventions, e.g. evaluation_snapshots at schema.ts:764-781).
CREATE INDEX IF NOT EXISTS idx_bvv_tenant_version
  ON brand_voice_versions(tenant_id, version DESC);
```

Rollback = read snapshot at target version, re-persist it as a **new** bump
(never mutate history), audit `change_reason='rollback'`.

### 2c. Migration numbers (ABOVE 236) + immutability snapshot

Current max key is `234_tenant_settings_vapi_webhook_secret`
(`schema.ts:5847`). Per the task constraint, propose **above 236** (235–236
left as a gap for parallel in-flight tracks — safe, migrations are append-only
and keyed lexicographically):

- **`237_brand_voice_versions`** — `CREATE TABLE brand_voice_versions` + RLS +
  index (§2b).
- **`238_tenant_settings_brand_voice_meta`** — add the version bookkeeping
  columns the composer/lock path reads without JSON digging:
  `brand_voice_version INTEGER NOT NULL DEFAULT 0`,
  `brand_voice_locked BOOLEAN NOT NULL DEFAULT false`,
  `brand_voice_updated_at TIMESTAMPTZ` (cool-down anchor).
  (The six-field JSONB data itself stays in the existing `brand_voice` column
  — additive, no migration needed for shape.)

**Immutability snapshot MUST be updated.** Both new keys are appended to
`MIGRATIONS` (`schema.ts:25`) *after* `234_…`, and their SHA-256 entries added
to `SNAPSHOT` in `packages/api/test/db/migration-immutability.test.ts`
(regen recipe is in that file's header comment). No existing migration value
may change (the May-2026 boot-crash guard).

---

## 3. API

Add a dedicated brand-voice router (Allowed Files: `packages/api/src/tenants/
brand/**`) rather than overloading `updateSettings`, because the lock +
cool-down + version-bump + audit semantics differ from plain settings PATCH.

- **`GET /api/settings/brand-voice`** — returns the six fields + `version`,
  `locked`, `updated_at`, and `cooldown_until`. `settings:view`.
- **`PUT /api/settings/brand-voice`** — the "explicit web action." `settings:update`.
  1. Zod-validate the six fields (new `brandVoiceSchema` alongside
     `updateSettingsSchema`, `contracts.ts:365`). Register ∈
     {formal,friendly,casual}; arrays capped (e.g. opening_lines ≤ 5,
     banned_phrases ≤ 50); persona_name/signoff length-bounded.
  2. **Cool-down gate:** reject with `423 BRAND_VOICE_COOLDOWN` if
     `now < brand_voice_updated_at + 15min`. (Onboarding's first write is
     exempt — `locked=false`.)
  3. **Re-validate:** run the same normalization the composer reads
     (`readToneFromSettings`) to guarantee the persisted blob round-trips to a
     usable tone; reject malformed.
  4. **Version bump (transactional):** `version = version + 1`; INSERT
     `brand_voice_versions` snapshot (`change_reason='web_edit'`); UPDATE
     `tenant_settings.brand_voice` (+ `brand_voice_version`,
     `brand_voice_locked=true`, `brand_voice_updated_at=NOW()`).
  5. **Audit:** `createAuditEvent` (`packages/api/src/audit/audit.ts:43`)
     with `eventType:'brand_voice.updated'`, `entityType:'brand_voice'`,
     `entityId: tenantId`, `metadata:{ fromVersion, toVersion, changedFields }`.
- **`GET /api/settings/brand-voice/versions`** — history list (`settings:view`).
- **`POST /api/settings/brand-voice/rollback`** `{ version }` — re-persists an
  older snapshot as a new bump (§2b); same cool-down + audit
  (`change_reason:'rollback'`).
- **Onboarding capture** reuses `PUT` with an `onboarding:true` flag that skips
  the cool-down and sets `locked=true` on completion, and writes the initial
  `brand_voice_versions` row with `change_reason='onboarding'`.

---

## 4. Frontend

### Onboarding capture step

Add a `BrandVoiceStep.tsx` to `packages/web/src/components/onboarding/v2/steps/`
(Allowed Files: `packages/web/src/onboarding/brand/**`), inserted after
`PackStep` / before `AiCheckStep`, and registered in the step sequence
(`OnboardingShell.tsx` / `Sidebar.tsx` / `MobileProgress.tsx`). Model it on the
existing config-panel pattern `VoiceConfigPanel.tsx`
(`packages/web/src/components/onboarding/v2/VoiceConfigPanel.tsx`).

Six controls: register (segmented 3-way), opening lines (chip/textarea list),
sign-off (text), banned phrases (chip list — same UX the correction loop
feeds), persona name (text), pronoun (we/I toggle). On submit → `PUT` with
`onboarding:true`.

### Settings edit surface

Add `BrandVoiceSheet.tsx` under `packages/web/src/components/settings/`,
registered in `SettingsPage.tsx` alongside peers like `StandingInstructionsSheet`
and `TerminologySheet`. Same six controls, plus:

- **Locked affordance:** when `locked`, fields render read-only with an
  explicit "Edit brand voice" unlock action (the "explicit web action" gate),
  a version badge (`v{n}`), and — after a save — a disabled state with a
  "You can edit again in ~14 min" countdown fed by `cooldown_until`.
- **Mobile contract:** ≥44px tap targets (`min-h-11`), no 320px overflow
  (per CLAUDE.md), pinned by a jsdom class-contract test + Playwright viewport
  test.

Wire a `packages/web/src/api/brandVoice.ts` client mirroring
`packages/web/src/api/settings.ts`.

---

## 5. Utterance tagging + deviation detection

### The single chokepoint: `composeBrandVoiceMessage` (`composer.ts:215`)

Every customer/owner-facing AI utterance in scope already funnels through this
one function (the four consumers in §1). This is where both tagging and
deviation detection belong — do them once, here, not in each caller.

**Tagging.** Widen `ComposeBrandVoiceResult` to carry the tenant brand-voice
version, resolved from the same settings read the composer already does:

```ts
export interface ComposeBrandVoiceResult {
  text: string;
  promptVersionId: string;   // existing: prompt template version
  brandVoiceVersion: number; // NEW: settings.brand_voice_version (0 = neutral)
  deviation?: BrandVoiceDeviation; // NEW (see below)
}
```

Each consumer then persists `brandVoiceVersion` onto the record it already
writes:
- Proposal-backed paths (review responses, reschedule when it becomes a
  proposal) stamp it into the **`_meta` envelope** validated at
  `assertValidProposalPayload` (`packages/api/src/proposals/contracts.ts` —
  `confidenceMetaEnvelopeSchema` at `contracts.ts:103`). Add
  `brandVoiceVersion` to `proposalConfidenceMetaSchema`.
- Direct-SMS paths (`recovery-composer.ts`, reschedule SMS) stamp it onto the
  outbound message row (new `brand_voice_version` column on the message/SMS
  send record, or into its existing metadata JSON).

This satisfies "every AI-generated message tagged with brand-voice version used."

### Deviation detection → N-002 confidence marker

The deviation signal already half-exists: `enforceBannedPhrases`
(`composer.ts`) returns `removed[]` and logs a warn when it had to strip
locked banned phrases — i.e. the model *deviated* from the locked profile.
Promote that from a log line to a structured result:

```ts
export interface BrandVoiceDeviation {
  kind: 'banned_phrase_stripped' | 'register_mismatch';
  detail: string[];       // e.g. the removed phrases
}
```

Populate `result.deviation` when `removed.length > 0` (V1). Callers map a
present `deviation` to a **downgraded N-002 confidence marker**: the
`_meta.overallConfidence` (vocabulary `CONFIDENCE_LEVELS =
['high','medium','low','very_low']`,
`packages/api/src/ai/guardrails/confidence.ts:36`) is set no higher than
`'low'` and a marker reason is attached, so the proposal is surfaced for
review instead of auto-approved. This threads N-011's deviation requirement
straight into the existing N-002/RV-007 confidence-marker gate rather than
inventing a parallel mechanism.

(V2 optional: a lightweight register-classifier pass to detect tone drift
beyond banned phrases — out of scope for the `[S]`/M build; the banned-phrase
signal is the concrete V1 hook.)

---

## 6. Test plan

Pure logic → unit tests same commit; DB-touching → Docker-gated integration
test (`packages/api/test/integration/`); UI → jsdom + Playwright (per CLAUDE.md).

1. **Onboarding captures all six fields** — integration test: onboarding `PUT`
   persists register/opening_lines/signoff/banned_phrases/persona_name/pronoun,
   `readToneFromSettings` round-trips them, `brand_voice_versions` v1 row
   written with `change_reason='onboarding'`. (Real Pool — pins the new
   columns per CLAUDE.md's "mocked-Pool shipped bad columns" learning.)
2. **Register + persona render** — unit test on `renderToneAuthority`
   (`prompts.ts`): friendly register and persona name appear in the tone
   authority; legacy `formality` still maps forward.
3. **Every AI message tagged** — unit test per consumer: `composeBrandVoiceMessage`
   returns `brandVoiceVersion`, and each of the four callers stamps it onto its
   record (`_meta` for proposals, message metadata for SMS).
4. **Deviation triggers marker** — unit test: tone with `banned_phrases`, model
   output containing one → `result.deviation.kind==='banned_phrase_stripped'`
   and caller sets `_meta.overallConfidence <= 'low'`.
5. **Changes audit-logged** — integration test: `PUT`/rollback emit a
   `brand_voice.updated` audit event with from/to version in metadata.
6. **Cool-down enforced** — unit + integration: second `PUT` within 15 min →
   `423 BRAND_VOICE_COOLDOWN`; after the window → success + version bump.
7. **Migration immutability** — `migration-immutability.test.ts` passes with the
   two new SNAPSHOT entries; existing hashes unchanged.
8. **Mobile UI** — jsdom class-contract (`min-h-11`, no overflow) + Playwright
   320px viewport for the settings sheet + onboarding step.

---

## 7. Effort, risks, rollout

**Effort: M.** PRD tags the story `[S]`, but "S" reflected the pre-existing
column only; the real surface is UI (two React surfaces) + versioning table +
version-bump/cool-down API + tagging plumbed through four consumers + the N-002
integration. Backend column reuse keeps it out of L.

**Risks**
- **Field-shape drift with the correction loop.** `banned_phrases` is grown by
  the N-009/P2-038 correction loop (`settings.ts:161-167`). The new UI must
  *merge*, never *overwrite* — an owner save must not wipe loop-learned bans.
  Mitigate: UI reads current bans and diffs; API treats `banned_phrases` as a
  union unless an explicit "remove" is sent.
- **Register/formality double-source.** Keeping both `register` and legacy
  `formality` risks divergence. Mitigate: `readToneFromSettings` makes
  `register` authoritative and derives from `formality` only when absent;
  never write `formality` from the new UI.
- **Version tag on non-composer utterances.** Any customer-facing AI text that
  does NOT go through `composeBrandVoiceMessage` (e.g. live voice agent turns)
  is unversioned. Scope note: N-011 tagging covers the composer-routed
  intents; live-voice tagging is a follow-up.
- **Immutability test churn** if 235/236 land from parallel tracks between
  design and build — rebase and re-hash; do not renumber.

**Rollout / flagging**
- Ship behind a `brand_voice_configurator` feature flag; onboarding step
  gated so it can dark-launch to new tenants first.
- Backfill: existing rows have `brand_voice='{}'`, `version=0`, `locked=false`
  → composer already falls back to neutral tone, so no data backfill required.
  First web save moves a tenant to v1.
- Deviation→marker downgrade is the riskiest behavioral change; flag it
  independently so it can be enabled after tagging is verified in production.

---

## Open question for the owner

The PRD build prompt names five brand-voice fields but the acceptance
criterion says "all six." This design treats `pronoun` (we/I) as the sixth
because it is already load-bearing in `renderToneAuthority`. **Confirm the
intended sixth field** (pronoun, or a distinct field such as
"preferred greeting" separate from "opening lines"?) before build, since it
changes the onboarding step's control count and the Zod schema.

# Reference Standard — ServiceOS / Rivet Audit (run-1)

**Established:** 2026-07-10. This is the yardstick every alignment / function / scale /
security verdict grades against (Track A1). Sources cited inline; where the source material
contradicts itself it is flagged as a **finding**, not papered over (Guardrail 4).

---

## (a) Persona & jobs-to-be-done

Source: `docs/strategy/day-in-the-life.md`, `docs/PRD-v3.md` §3-4.

- **Mike Rivera, 38** — 2-truck HVAC shop, Phoenix. One tech (Carlos). ~$680k rev. His real
  job is dispatcher/CSR/estimator/bookkeeper/collections/marketer *and* HVAC tech — only the
  last is the one he wanted. **JTBD: give the owner-hours back; be reachable by a spoken
  sentence while driving.**
- **Jenna Walsh, 41** — solo plumber, Cleveland. One truck, no employees, B2B property-manager
  referrals (Greenfield), water-damage-now emergencies. Proves the pitch for solo + B2B + MMS.
- **Top-of-funnel ICP** (PRD §4): the tech who just left a 500-person company, no systems —
  Rivet is the first software they buy and sets up the back office in onboarding.
- **North star:** every workflow must move a moment from the "Without" column to the "With"
  column — return owner hours — and be reachable by voice. A feature that adds admin to the
  owner's day fails the litmus test (day-in-the-life §"What this forces", #14).

**Anti-personas / out of scope** (day-in-the-life §"Scope discipline"): tax filing, payroll
calc, legal advice, vendor price negotiation, HR/firing, discounting or scope-change commitments
without owner approval, anything needing a separate dashboard for >30s. Multi-location / fleets,
consumer financing, full route optimization are **post-PMF**.

## (b) Per-tenant brand-voice contract

Source: `docs/strategy/day-in-the-life.md` #12 ("configurable, then locked"), PRD-v3,
`packages/api/src/ai/brand-voice/composer.ts`, `.../prompts.ts`.

**Contract elements** (the tone object, read from `tenant_settings.brand_voice` JSONB):
`formality` (casual|professional), `pronoun` (we|i), `vibe_words[]`, `business_name`,
`banned_phrases[]` (grown by the correction loop, N-009/P2-038).

**Enforcement points found in code:**
- `composeBrandVoiceMessage` (`composer.ts:155`) — tone rendered as a **non-overridable system
  instruction**; `maxChars` enforced in code *after* generation; routes through `gateway.complete()`
  only; typed error on empty output (never silent empty string). Banned phrases are injected as a
  **negative prompt**.
- Reputation drafts have their own brand-voice path (`reputation/brand-voice.ts`,
  `draft-public-response.ts`, `draft-private-followup.ts`).

**⚠ Candidate finding (to verify in audit):** the master prompt A1(b) requires the brand voice be
"**validated on every outbound message**" and names a **Brand-Voice Validator** living "in the
proposal engine." The code has a **composer** (generation-time, in-voice) and banned_phrases as a
*negative prompt* — but no post-generation **validator** that rejects/flags an already-drafted
outbound message containing a banned phrase or off-voice content was located on first pass.
Whether every outbound surface (SMS recovery, dunning, ETA texts, digest, review responses,
proposal SMS) routes through the composer is an open alignment question → audited in Track A2.

## (c) Naming convention — Rivet vs. ServiceOS

Source: `docs/PRD-v3.md:1-4` — **Brand name: Rivet. Product name: ServiceOS.**

**⚠ Finding candidate:** `docs/strategy/day-in-the-life.md` calls the product "**Serviceos**"
(mixed case) throughout, and the repo/dir is `Serviceos`. PRD uses "Rivet" for the brand and
"ServiceOS" for the product; competitive docs use "Rivet / ServiceOS". The convention exists but
is **applied inconsistently across docs and casing** (`ServiceOS` vs `Serviceos`). Audit verifies
whether user-facing surfaces (web app title, SMS signatures, emails) use the tenant `business_name`
(correct — the shop's name, not the product's) vs. leaking a product name.

## (d) SLO targets — committed (Track C1)

These are **fixed** by the master prompt (the 1,000-concurrent target does not move):

**Web / API (at 1,000 concurrent users):** p95 < 300 ms · p99 < 800 ms · error rate < 0.5%.

**Voice (sustain 1,000 concurrent voice sessions):** Deepgram STT first-token < 300 ms · end-to-end
turn latency (caller stops → AI audio starts) p95 < 1.5 s · dropped-session rate < 0.5% · supervisor
agent < 60 s.

**System:** proposal-execution failure rate < 1% · PgQueue depth < 1,000 sustained · **zero**
double-executions under concurrency · error budget defined and stated.

## Repo invariants (Guardrail 2 — the alignment yardstick)

Money = integer cents · time stored UTC / rendered tenant-local · every row `tenant_id` + **RLS
FORCE** · every mutation emits an audit event · all AI calls route the **LLM gateway** only ·
proposals are typed **Zod** contracts, **human-approved**, never auto-executed · AI-drafted prices
**catalog-resolved** before a proposal is built · high-stakes outputs pass the **supervisor agent**.
A workflow that breaks one is misaligned by definition; a fix that would break one is the wrong fix.

## Bad-day failure modes (must be provably handled — Track B4/D)

From day-in-the-life §"When Serviceos fails": (1) stale labor rate → caught in approval queue with
rate flag; (2) hallucinated part → low-confidence badge / ask-the-tech; (3) missed emergency intent
→ supervisor second-pass catches it; (4) dropped call → SMS recovery within 60s; (5) customer
game-plays price → **no negotiation**, route to owner with recommendation; (6) tech no-show → 1-star
review caught via GBP monitoring, draft public + private response; (7) EOD digest "what I wasn't
sure about" section.

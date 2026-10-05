# `packages/api` domain glossary

Terms the backend uses with a specific meaning. This is one context of a
multi-context repo — the root `CONTEXT-MAP.md` says which package owns which
vocabulary. System-wide decisions live in `docs/decisions.md` (D-NNN); the
speakable capability inventory in `docs/reference/voice-action-catalog.md`
(generated from the capability declarations — D-034). Coined during the voice-first effort (#833); add to it rather than letting
terms float.

- **Surface** — a way a person reaches the product: the live phone, a recorded
  memo, in-app chat (mic or typed). Web and mobile UI are surfaces too, but
  "surface" in voice docs means one of the three voice surfaces.
- **Transport** — an implementation of the phone surface: Twilio Gather,
  Twilio Media Streams (ConversationRelay is a third, not yet used). A
  capability targets "the phone", never a transport.
- **Shared dispatch** — the one per-skill implementation a family of
  capabilities runs through, regardless of surface. For lookups:
  `workers/voice-lookup-answer.ts#executeLookupAnswer`.
- **Surface adapter** — the thin per-surface caller of a shared dispatch. It
  owns only what is genuinely surface-specific: identity, reference
  resolution, response shape, failure copy, telemetry. It never contains a
  switch. Adding a surface means adding an adapter, not copying the switch.
  What an adapter serves versus refuses per intent family is declared in the
  coverage table.
- **Actor** — the tenant user a request is authorised AS. Chat: the signed-in
  operator. Memo: the recording's creator. Phone: resolved once from caller-ID
  at session establishment (`telephony/phone-actor.ts`) and stored as
  `session.actorUserId`; never derived from anything the caller says. On the
  phone, no actor means only the caller's own records and tenant-public
  lookups are answered.
- **Owner line** — a caller-ID that matches `tenant_settings.owner_phone` or
  the backup supervisor's mobile (`ownerSession`). Transport-level
  recognition, not identity proof; it gates voice approval (RV-071) and is one
  input to actor resolution, but it does not authorise lookups by itself.
- **Capability** — one thing a tradesperson can do by speaking: an intent plus
  whatever answers or executes it. The catalog lists them; the map (#833) is
  about making their surface coverage structural.
- **Capability declaration** — the one entry per intent in
  `capabilities/capabilities.ts#CAPABILITIES` (D-034): kind, proposal type,
  spoken example, and per-surface opt-outs (`unavailableOn`, each with a
  reason). Every surface's intent map is derived from it, so a new
  declaration is served everywhere unless it opts out.
- **Parity** — the same capability behaves the same on every surface it
  targets. Structural parity means a new capability cannot land on one surface
  and silently miss another. Until parity is structural, the coverage table
  declares where today's behavior diverges; the turn pipeline is where it
  stops being able to.
- **Proven** — a capability has a real-database integration test on the
  surface in question (`test/integration/`), not only an in-memory one. For
  execution, claimed by a `provesExecution('<key>')` title tag in a file that
  opens a real pool, and gated over every writing capability (D-034 part 2,
  `test/capabilities/proven-bar.test.ts`).
- **Proposal-first** (D-004) — the AI never writes to operational entities;
  it drafts a typed proposal a human approves. Lookups are read-only and are
  never proposals.
- **Turn pipeline** — the one per-turn implementation every live voice
  surface runs through; the guard-ladder order and intent-family precedence
  live here and nowhere else. Today it is being consolidated onto
  `ai/voice-turn/create-voice-turn-processor.ts#speechTurn`; until parity is
  structural, the coverage table declares what runs where.
- **Coverage table** — the declared cell per (intent family, surface):
  reachable, or refuse with the honest copy
  (`ai/voice-turn/coverage-table.ts`). A structural test forbids undeclared
  cells, so refusals happen on purpose and silence is impossible.
- **Graded call** (#1602, D-040) — a production phone call the nightly
  sampler judged with the SAME Layer 2 graders the CI harness uses
  (`voice/quality/grade-voice-session.ts` over `ai/voice-quality/graders/*`),
  from its stored transcript only. Gradable means: ended, `voice_inbound`,
  the recording disclosure played (`consent_events` recording/implicit/voice
  for the session, not revoked) and billable (`call_usage_events` — the
  owner's own test calls are not). The grade (`voice_session_grades`) carries
  per-criterion pass/fail with the judge's rationale and is advisory: it never
  changes a proposal, an outcome or billing. The 7-day graded pass rate is the
  production counterpart of the Layer 2 launch gate (SLO
  `voice_graded_pass_rate_7d`).

## The evidence ladder (D-031, D-032)

Terms for how the product states what it can prove about itself. The PRD's
§8.0 and §16 apply them row by row; these are the definitions only.

- **Rung** — a 0–6 verdict on the *evidence* for one user story or
  invariant, never on its value or on a reading of the source (D-031). 4
  means a real database proved the write and its audit event; 5 adds
  reachability; 6 means observed serving real tenants. A rung is published
  only with the command that earns it.
- **Evidence class** — the kind of proof behind a rung, which fixes its
  ceiling: no evidence or code only, proven with mocked or in-memory
  dependencies, a structural guard with a negative control, a real-database
  write without its audit event (4−), a real-database write with its audit
  event, plus reachability. A mocked dependency caps a claim at the mock.
- **Tenant grade (T0–T4)** — the second dimension of done (D-032): how many
  tenants the proof met and how. T0 one tenant; T1 a neighbour cannot see or
  touch the first's rows; T2 a neighbour's data does not change the first's
  answer; T3 two differently configured tenants each get their own correct
  result in one run; T4 the production tenant selector runs, every eligible
  tenant is processed, and one tenant's failure does not stop the rest. The
  grade caps the rung: 4 needs T1, 5 needs T2 (T3 where per-tenant
  configuration is read), a tenant-iterating capability stays at 4 until T4.
- **Sweep** — a background pass that serves many tenants in one run (digest,
  reminders, dunning, sync). Its tenant grade is judged on the pass, not on a
  single tenant's outcome.
- **Enumerator** — the production selector that decides which tenants a
  sweep visits. A test that substitutes a hand-picked list for it has replaced
  the thing under test, and cannot earn T4.
- **Reachability** — a persona can get to a capability on the surface the
  story names, as that persona, with no database edit, no platform-admin
  action and no environment switch. What separates rung 5 from rung 4.
- **Unlit-able** — a capability no surface can switch on at all, as opposed
  to one that is merely off by default or lacks an owner-facing control. It
  caps at 4 regardless of how well it is tested.

# `packages/api` domain glossary

Terms the backend uses with a specific meaning. This is one context of a
multi-context repo — the root `CONTEXT-MAP.md` says which package owns which
vocabulary. System-wide decisions live in `docs/decisions.md` (D-NNN); the
speakable capability inventory in `docs/reference/voice-action-catalog.md`.
Coined during the voice-first effort (#833); add to it rather than letting
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
- **Parity** — the same capability behaves the same on every surface it
  targets. Structural parity means a new capability cannot land on one surface
  and silently miss another.
- **Proven** — a capability has a real-database integration test on the
  surface in question (`test/integration/`), not only an in-memory one.
- **Proposal-first** (D-004) — the AI never writes to operational entities;
  it drafts a typed proposal a human approves. Lookups are read-only and are
  never proposals.

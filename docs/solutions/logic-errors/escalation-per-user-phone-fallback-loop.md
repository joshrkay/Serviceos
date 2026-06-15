---
title: "Per-user escalation phone: fallback altitude defeats rotation and loops the dial cascade"
date: 2026-06-15
track: bug
problem_type: logic-errors
module: "packages/api/src/telephony/dispatcher-phone-resolver.ts, packages/api/src/ai/skills/escalate-to-human.ts, packages/api/src/routes/telephony.ts"
tags: ["telephony", "escalation", "on-call", "dispatcher", "voice", "infinite-loop", "rotation"]
related: ["docs/solutions/architecture-patterns/voice-quality-corpus-prompt-coverage.md"]
---

## Problem
Routing inbound-call escalation to a tradesperson's own mobile
(`users.mobile_number`) instead of the shared `business_phone` hides a two-part
"altitude" trap. Getting either part wrong silently breaks per-user routing or —
worse — makes the `<Dial>` cascade redial the shared line forever.

## Symptoms
- Per-user selection looks wired, but EVERY call rings the same number — the
  on-call rotation never advances past entry 0; or
- A no-answer on the shared business line never reaches voicemail: Twilio's
  `/dial-result` re-dials the same number in an unbounded loop.

## What Didn't Work
**Putting the `business_phone` fallback INSIDE the resolver.** The rotation walk
in `escalateToHuman` treats a resolver `null` as "advance to the next on-call
user" and any non-null as "dial this one". A resolver that returns
`business_phone` when the user has no mobile makes EVERY rotation entry resolve
non-null → the walk stops at entry 0 → per-user selection is silently defeated
for everyone after the first entry.

**Wiring the call-site fallback into the `/dial-result` cascade too.** Even with
the fallback correctly placed at the `!chosen` branch (after rotation
exhaustion), forwarding `businessPhoneFallbackResolver` into the cascade
re-invocation (`routes/telephony.ts`) loops: the fallback returns a transfer
WITHOUT advancing the rotation cursor, so on a no-answer the cascade re-enters
`!chosen`, redials the same shared line, and never terminates. Pre-existing
cascade termination relied on `!chosen` returning `escalated: false`.

## Solution
Two rules:

1. **Per-user resolver returns number-or-`null`; the tenant fallback lives at the
   call site, only after rotation exhaustion.**
   ```ts
   // dispatcher-phone-resolver.ts
   createUserPhoneDispatcherResolver(userRepo) // → user.mobileNumber ?? null
   createBusinessPhoneFallback(settingsRepo)   // SEPARATE — consumed only in !chosen
   ```
   ```ts
   // escalate-to-human.ts, after the rotation walk:
   if (!chosen) {
     const fallbackPhone = businessPhoneFallbackResolver
       ? await businessPhoneFallbackResolver(tenantId).catch(() => null)
       : null;
     if (fallbackPhone) { /* dial the business line once, sentinel transfer */ }
     else { /* escalated: false → voicemail / call_me_back */ }
   }
   ```

2. **The fallback is INITIAL-ATTEMPT-ONLY — never on the cascade.** Omit
   `businessPhoneFallbackResolver` from the `escalateToHuman` call in
   `routes/telephony.ts`'s `/dial-result` handler, so an exhausted/numberless
   rotation returns `escalated: false` there and falls through to voicemail.

## Why This Works
The rotation walk's entire advance mechanism is "null = skip"; a per-user
resolver that never returns null cannot advance. And the cascade is a redial
loop by design (try the NEXT dispatcher) whose only terminator is
`escalated: false` — so any branch that returns a transfer without advancing the
cursor must not be reachable on re-invocation.

## Prevention
- **Resolver contract:** a per-entity resolver feeding a rotation/cursor walk
  returns the value OR `null`; tenant-level last-resorts live at the call site,
  not inside the resolver.
- **One-shot last-resort:** a fallback dial that does not advance the cursor must
  fire at most once — gate it out of any cascade/retry path.
- **Regression test** (`escalate-to-human.test.ts`): `escalateToHuman` with a
  numberless rotation and NO `businessPhoneFallbackResolver` must return
  `escalated: false` (mirrors the cascade), proving the loop cannot form.

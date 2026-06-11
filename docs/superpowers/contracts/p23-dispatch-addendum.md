# Phase 23 (Jobber Parity Closure) — Multi-Agent Dispatch Addendum

## Wave plan

| Wave | Stories | Run-mode | Blocks |
|---|---|---|---|
| 23A | P23-002, P23-003, P23-005 | parallel (disjoint file sets) | P23-003 unlocks P23-004 |
| 23B | P23-004 | single agent | — |
| 23C | P23-001 | single agent (requires P22-003/004 merged) | sprint complete |

23A can start immediately and runs as three concurrent threads. P23-001 is
gated on Phase 22 wave 22B (PWA) merging — schedule it last.

## Migration ledger

All migrations: **discover the next free migration number by reading
`packages/api/src/db/schema.ts` at dispatch time** (schema is past 127; old
ledger reservations are stale). Expected additive migrations:
- P23-001: `device_push_tokens`
- P23-002: `financing_offers`
- P23-003: `checklist_templates` + `job_checklists`
- P23-005: `webhook_subscriptions` + `webhook_deliveries`
- P23-004: none

---

## P23-001 — Capacitor native shell

**Wave:** 23C (after P22-003 and P22-004 merge)
**Forbidden files:**
- `packages/shared/**`
- `packages/web/src/pages/**`, `packages/web/src/components/**` EXCEPT
  `components/voice/useGlobalVoice.ts` (native-mic branch only)
- `packages/api/src/db/pg-base.ts`

**Allowed files:** as listed in story.

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  (cd packages/api && npx tsc --project tsconfig.build.json --noEmit) && \
  (cd packages/web && npm run build) && \
  (cd packages/api && npm test -- -t "push-token|push-notifications|P23-001") && \
  (cd packages/web && npm test -- --run -t "native|deep-link|P23-001")
```

**Risk notes:**
- **No UI forks.** The native package wraps the existing web build; any
  screen-level divergence is a review rejection.
- **Token hygiene**: prune invalid tokens on provider 410/invalid responses;
  never log raw tokens.
- Native project files (xcodeproj/gradle) are large generated trees — commit
  them, but reviewers focus on the bridge + push service code.

---

## P23-002 — Consumer financing

**Wave:** 23A
**Forbidden files:**
- `packages/api/src/billing/**` (READ ONLY — no financing math in the engine)
- `packages/api/src/estimates/**` (READ ONLY — read totals; do not modify)
- `packages/shared/**`, `packages/api/src/db/pg-base.ts`

**Allowed files:** as listed in story.

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  (cd packages/api && npx tsc --project tsconfig.build.json --noEmit) && \
  (cd packages/api && npm test -- -t "financing|P23-002") && \
  (cd packages/web && npm test -- --run -t "Financing|P23-002")
```

**Risk notes:**
- **Compliance copy**: the monthly figure must read as an estimate
  ("as low as ~$X/mo, subject to approval"), never a credit promise. Treat
  the badge copy as load-bearing.
- **Credential encryption**: reuse the P15-001 AES-256-GCM pattern; do not
  invent a second crypto util.

---

## P23-003 — Job checklists

**Wave:** 23A
**Forbidden files:**
- `packages/api/src/jobs/job.ts` (interface — do NOT modify)
- `packages/api/src/jobs/pg-job.ts` (READ ONLY)
- `packages/shared/**`, `packages/api/src/db/pg-base.ts`

**Allowed files:** as listed in story.

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  (cd packages/api && npx tsc --project tsconfig.build.json --noEmit) && \
  (cd packages/api && npm test -- -t "checklist|P23-003") && \
  (cd packages/web && npm test -- --run -t "JobChecklist|P23-003")
```

**Risk notes:**
- **Concurrency on items_state**: two techs or tech+voice updating the same
  checklist — pick one strategy (jsonb_set single-row update recommended)
  and test interleaving.
- **No form builder.** Template editing is JSON-level/seed-level only;
  resist UI scope creep.

---

## P23-004 — Voice-fillable checklists

**Wave:** 23B (after P23-003)
**Forbidden files:**
- `packages/api/src/checklists/**` (READ ONLY — call the service)
- `packages/api/src/ai/agents/**` (FSM is pure — do NOT modify)
- `packages/shared/**`, `packages/api/src/db/schema.ts`

**Allowed files:** as listed in story.

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  (cd packages/api && npx tsc --project tsconfig.build.json --noEmit) && \
  (cd packages/api && npm test -- -t "checklist-fill|fill-checklist|P23-004")
```

**Risk notes:**
- **Skip, never guess**: an ambiguous narration fragment maps to nothing;
  the TTS summary discloses skips. This is the trust contract.
- **Spoken numbers**: "point eight", "zero point eight", "eighty" — test the
  parser table explicitly.

---

## P23-005 — Outbound webhooks

**Wave:** 23A
**Forbidden files:**
- `packages/api/src/audit/**` (READ ONLY — subscribe, don't modify)
- `packages/api/src/webhooks/routes.ts` + inbound handlers (READ ONLY)
- `packages/shared/**`, `packages/api/src/db/pg-base.ts`

**Allowed files:** as listed in story.

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  (cd packages/api && npx tsc --project tsconfig.build.json --noEmit) && \
  (cd packages/api && npm test -- -t "outbound-webhook|webhook-delivery|webhook-subscription|P23-005") && \
  (cd packages/web && npm test -- --run -t "WebhooksSettings|P23-005")
```

**Risk notes:**
- **SSRF is the review focus**: https-only, resolve-and-reject private
  ranges, no redirects followed cross-host.
- **Allowlist, not passthrough**: raw audit rows contain internal metadata;
  only the versioned public payload shape leaves the system.
- **Delivery worker** uses the P0-009 async worker pattern; backoff schedule
  in one constant, tested.

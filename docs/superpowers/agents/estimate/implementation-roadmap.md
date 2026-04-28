# Estimate Agent — Implementation Roadmap

Phase 10 in the gap-story sequence. Sibling to Phase 9 (invoice agent).

**Migration reservations:** 059-061. (Phase 9 invoice agent reserved 055-058.)

## Dependencies

| Depends on | Why |
|---|---|
| Existing `packages/api/src/estimates/*` | All estimate domain skills already exist |
| Existing `packages/api/src/ai/tasks/estimate-*` | AI drafting + edit deltas |
| Phase 9 invoice agent | Conversion target on acceptance |
| Phase 8 customer-followup agent | Out-bound SMS/email for sent estimates and `estimate_nudge_*` rules |

## Wave plan

```
Wave 10A — foundations (parallel, 3 stories)
  P10-001  estimate agent state machine module
  P10-002  estimate idempotency + revision counter
  P10-003  hosted-view route + view-token mint + view audit

Wave 10B — orchestration (parallel after 10A merges, 3 stories)
  P10-004  auto-approve policy + tenant settings
  P10-005  accept / decline / revision-request flow
  P10-006  invoice-agent handoff on accept

Wave 10C — UX + sweep (parallel after 10B, 2 stories)
  P10-007  estimate HTML render
  P10-008  expire sweep cron

Wave 10D — gates (sequential, 1 story)
  P10-009  agent ON flag + tenant rollout
```

Total stories: **9**. Estimated wall-clock: **~2 days** with parallelism.

## Story specs

---

### P10-001 — Estimate agent state machine module

**Status:** new
**Allowed files:**
- `packages/api/src/agents/estimate/state-machine.ts` (new)
- `packages/api/src/agents/estimate/types.ts` (new)
- `packages/api/src/agents/estimate/index.ts` (new — barrel)
- `packages/api/src/agents/estimate/state-machine.test.ts` (new)

**Spec:**
- Implement the typed state machine from `flow.md` as a pure function `transition(state, event, context)`.
- Property test: every (state, event) pair from the transition table.
- All `IllegalTransition` errors include `{ from, event, tenantId, estimateId }`.
- Mirror P9-001 patterns; consider extracting a tiny shared `state-machine` helper module if a clean abstraction emerges (do NOT force it pre-emptively).

**Verification gate:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit && npx vitest run src/agents/estimate/state-machine.test.ts --coverage
```

---

### P10-002 — Idempotency + revision counter

**Status:** new
**Allowed files:**
- `packages/api/src/db/schema.ts` (migration 059)
- `packages/api/src/agents/estimate/create-draft.ts` (new)
- `packages/api/src/agents/estimate/create-draft.test.ts` (new)

**Migration 059:**
```sql
CREATE TABLE estimate_idempotency (
  tenant_id UUID NOT NULL,
  source TEXT NOT NULL,             -- 'manual' | 'ai_proposal' | 'lead_pipeline'
  source_ref TEXT NOT NULL,
  estimate_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, source, source_ref)
);
ALTER TABLE estimate_idempotency ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_iso ON estimate_idempotency USING (tenant_id = current_setting('app.tenant_id')::uuid);

ALTER TABLE estimates
  ADD COLUMN IF NOT EXISTS revision INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
```

**Spec:**
- `createEstimateDraft({source, sourceRef, ...})` → `INSERT ... ON CONFLICT DO NOTHING RETURNING *`. Return existing on conflict.
- Default `expires_at = NOW() + INTERVAL '30 days'` on first send (not draft creation).

**Verification gate:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit && npx vitest run src/agents/estimate/create-draft.test.ts
```

---

### P10-003 — Hosted-view route + view-token mint + view audit

**Status:** new
**Allowed files:**
- `packages/api/src/agents/estimate/render-estimate.ts` (new)
- `packages/api/src/agents/estimate/record-view.ts` (new)
- `packages/api/src/routes/estimate-view.ts` (new — public token-gated route)
- `packages/api/src/db/schema.ts` (migration 060)
- `packages/web/src/pages/EstimateView.tsx` (new — hosted view, no auth)

**Migration 060:**
```sql
ALTER TABLE estimates
  ADD COLUMN IF NOT EXISTS view_token TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS html_snapshot TEXT;

CREATE TABLE estimate_view_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  estimate_id UUID NOT NULL,
  revision INT NOT NULL,
  viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip TEXT,
  user_agent TEXT
);
ALTER TABLE estimate_view_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_iso ON estimate_view_events USING (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE INDEX estimate_view_events_estimate_idx ON estimate_view_events(tenant_id, estimate_id, viewed_at DESC);
```

**Spec:**
- Route `GET /e/:viewToken` → resolve estimate by token, render HTML snapshot, record view event.
- Token rotated on every revision (mint new token, invalidate old).
- Hosted view shows Accept / Decline / Request Revision buttons.

**Verification gate:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit && npx vitest run src/routes/estimate-view.test.ts src/agents/estimate/record-view.test.ts
```

---

### P10-004 — Auto-approve policy + tenant settings

**Status:** new
**Allowed files:**
- `packages/api/src/db/schema.ts` (migration 061)
- `packages/api/src/agents/estimate/auto-approve.ts` (new)
- `packages/api/src/agents/estimate/auto-approve.test.ts` (new)
- `packages/web/src/pages/SettingsBilling.tsx` (modify — add estimate auto-approve toggle)

**Migration 061:**
```sql
ALTER TABLE tenant_settings
  ADD COLUMN estimate_auto_approve_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN estimate_auto_approve_max_cents BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN estimate_auto_approve_min_confidence NUMERIC(3,2) NOT NULL DEFAULT 0.90;
```

**Spec:** see `skills.md → check_auto_approve`. Default OFF.

**Verification gate:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit && npx vitest run src/agents/estimate/auto-approve.test.ts
```

---

### P10-005 — Accept / decline / revision-request flow

**Status:** new
**Allowed files:**
- `packages/api/src/agents/estimate/accept-estimate.ts` (new)
- `packages/api/src/agents/estimate/decline-estimate.ts` (new)
- `packages/api/src/agents/estimate/request-revision.ts` (new)
- `packages/api/src/routes/estimate-view.ts` (modify — POST endpoints for buttons)
- `packages/api/src/agents/estimate/*.test.ts` (new tests)

**Spec:**
- POST `/e/:viewToken/accept` → `accept_estimate` skill → transition `awaiting_response → converting`.
- POST `/e/:viewToken/decline` → `decline_estimate` skill → `declined`.
- POST `/e/:viewToken/revise` → `request_revision` skill → snapshots prior rev, transitions to `revising`.
- Each route writes audit + body fields (signature object on accept, reason on decline/revise).

**Verification gate:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit && npx vitest run src/agents/estimate/accept-estimate.test.ts src/agents/estimate/decline-estimate.test.ts src/agents/estimate/request-revision.test.ts
```

---

### P10-006 — Invoice-agent handoff on accept

**Status:** new
**Allowed files:**
- `packages/api/src/agents/estimate/convert-to-invoice.ts` (new)
- `packages/api/src/agents/invoice/create-draft.ts` (modify — handle `source: 'estimate_accepted'`)
- `packages/api/src/agents/estimate/convert-to-invoice.test.ts` (new)

**Spec:**
- `convertToInvoice` emits `estimate_accepted` event onto a queue (do NOT direct-import invoice agent — keep modules decoupled).
- Worker consumes the event and calls invoice agent's `createInvoiceDraft`.
- On success: estimate transitions `converting → accepted` with `linked_invoice_id`.
- On failure: estimate stays in `converting`; alert; retry queued (max 3).

**Verification gate:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit && npx vitest run src/agents/estimate/convert-to-invoice.test.ts
```

---

### P10-007 — Estimate HTML render

**Status:** new
**Allowed files:**
- `packages/api/src/agents/estimate/render-estimate.ts` (modify — flesh out template)
- `packages/api/src/templates/estimate-html.ts` (new — Handlebars-style template)
- `packages/api/src/agents/estimate/render-estimate.test.ts` (new)

**Spec:**
- Tenant-customizable header/footer (uses tenant branding from existing `tenant_branding` settings).
- v1: HTML only. v2 work: real PDF.
- Snapshot is **immutable** — once persisted on a revision, no edits.

**Verification gate:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit && npx vitest run src/agents/estimate/render-estimate.test.ts
```

---

### P10-008 — Expire sweep cron

**Status:** new
**Allowed files:**
- `packages/api/src/agents/estimate/expire-sweep.ts` (new)
- `packages/api/src/workers/scheduler.ts` (modify — register cron)
- `packages/api/src/agents/estimate/expire-sweep.test.ts` (new)

**Spec:**
- Run every 1 hour (`0 * * * *`).
- Query `estimates WHERE state = 'awaiting_response' AND expires_at < NOW()`.
- For each, transition to `expired` + audit.
- Followup agent's `pre_send_validate` already re-checks state — so pending nudges naturally suppress.

**Verification gate:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit && npx vitest run src/agents/estimate/expire-sweep.test.ts
```

---

### P10-009 — Agent ON flag + tenant rollout

**Status:** new (gate)
**Allowed files:**
- `packages/api/src/agents/estimate/index.ts` (modify — add `isAgentEnabled(tenantId)`)
- `packages/api/src/routes/estimates.ts` (modify — delegate to agent when enabled, legacy path when not)
- `packages/web/src/pages/SettingsBilling.tsx` (modify — agent ON/OFF toggle for owners)
- `packages/api/src/agents/estimate/index.test.ts` (new)

**Spec:**
- Feature-flag-gated: default OFF. When ON, all state changes flow through `transition()`.
- When OFF: existing legacy estimate routes handle everything (today's behavior).
- Reversible.

**Verification gate:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit && npx vitest run src/agents/estimate/index.test.ts
```

## Cross-cutting checks (CI gate before agent ON)

- [ ] All P10 stories merged
- [ ] Test plan happy paths H-1 through H-6 green in integration suite
- [ ] State-machine completeness 100% branch coverage
- [ ] Hosted-view route smoke test green (token-gated, no auth bypass)
- [ ] Expire sweep cron registered + running in staging worker logs
- [ ] Auto-approve default OFF verified across staging tenants
- [ ] Conversion handoff to invoice agent verified end-to-end (estimate accept → invoice draft created → invoice paid)
- [ ] Audit replay green
- [ ] Tenant isolation MT-1 / MT-2 green

## Out of scope (deferred to later phases)

- **PDF rendering** (Phase 11)
- **E-signature integration** (Phase 11 — DocuSign / Dropbox Sign)
- **Good/Better/Best option packages** (Phase 12)
- **Per-tenant expiry-window override UI** (Phase 11)
- **Multi-currency estimates** (Phase 11)
- **Customer self-serve "Request changes" with structured fields** (Phase 12 — currently free-text only)

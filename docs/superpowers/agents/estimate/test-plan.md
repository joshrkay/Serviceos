# Estimate Agent — Test Plan

Coverage targets: **100% branch coverage on state transitions and idempotency**, **≥ 90% line coverage on agent skills**, **integration tests against ephemeral Postgres**.

## Categories

### 1. Happy paths

| ID | Scenario | Entry | Expected terminal state | Side effects asserted |
|---|---|---|---|---|
| H-1 | Manual estimate sent → accepted → invoice created | dispatcher `POST /api/estimates` | `accepted` | view link, `approved-estimate-metadata` row, invoice id linked |
| H-2 | AI-drafted estimate auto-approved, accepted | source=`ai_proposal`, conf=0.95, total=$800, cap=$1000 | `accepted` | no human approval row; invoice created |
| H-3 | Estimate sent → declined | customer clicks Decline | `declined` | follow-up nudges suppressed |
| H-4 | Estimate sent → expired | no response in 30d, sweep runs | `expired` | audit row, nudges suppressed |
| H-5 | Revision requested → resubmitted → accepted | customer comments → dispatcher revises → resends | `accepted` | snapshot of prior rev preserved, new view token issued |
| H-6 | Lead pipeline auto-quote → human approves → accepted | source=`lead_pipeline`, AI confidence=0.85 (below 0.9) → queued | `accepted` | proposal row, snapshot, invoice id |

### 2. Idempotency

| ID | Scenario | Expected |
|---|---|---|
| ID-1 | Same lead fires `lead_pipeline` event twice | one estimate; idempotent: true |
| ID-2 | Send retried after followup-agent transient error | one task in followup queue, two send-attempts logged but one delivery |
| ID-3 | Two simultaneous Accept clicks | one accept; one transition to `converting`; one invoice id returned to both calls |
| ID-4 | Accept attempted on stale revision (after a newer rev was sent) | `RevisionMismatch`; current rev URL re-sent to customer |

### 3. Validation

| ID | Scenario | Expected |
|---|---|---|
| V-1 | Empty line items | rejected |
| V-2 | Total mismatch | rejected w/ structured error |
| V-3 | Currency mismatch | rejected |
| V-4 | Customer with no contact channel | rejected (cannot send) |
| V-5 | `expires_at` < `now` | rejected |
| V-6 | Negative total | rejected (estimates never credit) |

### 4. Auto-approve policy

| ID | Scenario | Expected |
|---|---|---|
| AA-1 | Tenant flag off | always queue proposal |
| AA-2 | Flag on, source=`manual` | manual bypasses agent's approval gate (UI = approval) |
| AA-3 | Flag on, source=`ai_proposal`, total=$800, cap=$1000, conf=0.95 | auto-approve |
| AA-4 | Flag on, source=`ai_proposal`, total=$1500, cap=$1000 | queue |
| AA-5 | Flag on, source=`lead_pipeline`, conf=0.85 | queue (below 0.9 threshold) |
| AA-6 | AI confidence floor (0.7 minimum to even draft via AI) | confidence=0.65 → no AI draft, dispatcher must manually compose |

### 5. Hosted view + tokens

| ID | Scenario | Expected |
|---|---|---|
| HV-1 | View URL fetched | `record_view` audit row; no state change |
| HV-2 | View URL fetched twice | two view audit rows |
| HV-3 | Old revision view URL after revision | 404 (token rotated on revision) |
| HV-4 | Accept clicked on view URL | state → `converting`; conversion triggered |
| HV-5 | Decline clicked on view URL | state → `declined` |
| HV-6 | Accept after expiry | `EstimateExpired`; show "expired" page; do NOT transition |

### 6. Conversion to invoice

| ID | Scenario | Expected |
|---|---|---|
| C-1 | Accept emits `estimate_accepted` event | invoice agent receives event; invoice draft created with line items copied |
| C-2 | Invoice agent fails to create draft | estimate stays in `converting`; alert; retry queued |
| C-3 | Invoice agent succeeds | estimate transitions `converting → accepted` with linked invoice id |
| C-4 | Same estimate accepted twice (race) | one invoice; `AlreadyAccepted` on second |

### 7. Multi-tenant isolation

| ID | Scenario | Expected |
|---|---|---|
| MT-1 | Tenant A view token never resolves to tenant B's estimate | strict tenant scoping; cross-tenant lookups REJECTED |
| MT-2 | Tenant A's auto-approve config never affects tenant B | per-tenant settings load |

### 8. State-machine completeness

For every (state, event) pair NOT in the transition table, assert `IllegalTransition` and an audit row. Property-test from the table.

### 9. Cost ceilings

| ID | Scenario | Expected |
|---|---|---|
| C-1 | AI draft via gateway | tokens × cost ≤ $0.05 |
| C-2 | Edit eval | bounded by gateway budget |

### 10. Failure recovery

| ID | Scenario | Expected |
|---|---|---|
| F-1 | Followup agent send error (Twilio 5xx) | back to `awaiting_approval`; alert; retry on demand |
| F-2 | LLM timeout during AI draft | dispatcher prompted to manually compose; degraded-mode log |
| F-3 | DB error during validation | task returned with delay; no half-state |
| F-4 | Render fails | block transition to `awaiting_response`; alert; retry queued |

### 11. Authorization

| ID | Scenario | Expected |
|---|---|---|
| AZ-1 | Technician attempts `decline_estimate` on customer's behalf | `RoleNotPermitted` (only customer or dispatcher) |
| AZ-2 | Cross-tenant accept attempt via raw token | `NotFound` |

### 12. Audit completeness

For each happy path: assert audit chain has every state transition with `actor_type`, `from_state`, `to_state`, `reason`. Audit-replay reconstructs final state — must match DB.

### 13. Expiry sweep

| ID | Scenario | Expected |
|---|---|---|
| EX-1 | Estimate at 30d boundary | sweep transitions to `expired` |
| EX-2 | Estimate viewed at 29d but no accept | still expires at 30d |
| EX-3 | Estimate accepted at 29.9d | NOT expired; `accepted` wins |
| EX-4 | Sweep run twice in same window | idempotent |

### 14. Performance

| ID | Scenario | Target |
|---|---|---|
| Perf-1 | Validate draft | p95 < 200ms |
| Perf-2 | Mint view token + render HTML | p95 < 500ms |
| Perf-3 | Accept → invoice creation handoff | p95 < 1s |
| Perf-4 | Expire sweep (1k estimates) | p95 < 30s |

### 15. Integration with adjacent agents

| ID | Scenario | Expected |
|---|---|---|
| I-1 | Estimate sent → followup agent fires `estimate_nudge_3d` if no view in 3d | one SMS sent (per `customer-followup` test plan) |
| I-2 | Estimate viewed within 24h of nudge fire-time | followup agent suppresses the nudge |
| I-3 | Estimate accepted → invoice agent creates draft | linked invoice id in `accepted` state |
| I-4 | Customer replies STOP to nudge | followup adds DNC; estimate agent untouched |

### 16. End-to-end (happy path)

```
lead inquiry → AI auto-quote (conf 0.95)
  → estimate_agent: draft 
  → validate (auto) 
  → auto_approve (tenant on, $800 ≤ $1000 cap) 
  → sending 
  → render HTML + mint token 
  → followup_agent send SMS to customer 
  → awaiting_response 
  → customer views (audit only) 
  → 3d later: customer clicks Accept 
  → converting 
  → invoice_agent: draft (source=estimate_accepted) 
  → estimate_agent: accepted (linked to invoice id) 
  → invoice_agent continues lifecycle...
```

Asserted: 5 audit rows, 1 view-record row, 1 approved-estimate-metadata row, 1 invoice draft, 0 errors.

### 17. Pre-launch checklist (must pass before turning agent ON in production)

- [ ] All happy paths green (H-1 through H-6)
- [ ] All idempotency cases green
- [ ] State-machine completeness 100% branch coverage
- [ ] Hosted-view route token-gated, no auth bypass
- [ ] Expiry sweep cron registered (`0 * * * *`)
- [ ] Auto-approve flag DEFAULT OFF for new tenants
- [ ] Audit replay test green
- [ ] Tenant isolation green
- [ ] Authorization green
- [ ] Conversion handoff to invoice agent verified end-to-end
- [ ] Estimate retention set ≥ 7 years (soft-delete)

## Test fixtures

Reusable fixtures under `packages/api/test/fixtures/estimate/`:
- `tenant.basic.json`
- `tenant.auto-approve.json`
- `customer.with-contact.json`
- `customer.no-contact.json` (V-4)
- `lead.basic.json`
- `estimate.draft.json`
- `estimate.sent.json`
- `view-events/viewed.json`
- `view-events/accepted.json`
- `view-events/declined.json`

## Tooling

- **Vitest** with coverage. CI gate: 90% line / 100% branch on agent state machine.
- **Property-based** transition tests.
- **Ephemeral Postgres** via testcontainers.
- **MSW** for hosted-view route smoke tests.

# QA Manual Testing Focus Areas — 2026-10-27

**Purpose**: Prioritize manual testing based on commit themes since 2026-10-20

---

## High-Risk Areas (Changed Significantly)

### 1. Audit Events & Webhook Handling (PR #1835, #1834)
**What changed**: Raw audit_events inserts consolidated, webhook payload minimization

**Test these**:
- [ ] Create an estimate → verify audit event is recorded with correct tenant_id
- [ ] Create an invoice → verify webhook event doesn't expose PII
- [ ] Create a proposal via voice → verify audit trail is complete
- [ ] Check `/admin/audit-log` page displays correctly
- [ ] Verify webhook payload contains only allowlisted fields

**Risk**: If audit events not captured, compliance/audit trail is broken
**If webhook PII exposed**: Data privacy violation

---

### 2. AI Run Traceability (PR #1832)
**What changed**: Classifier runs, review responses, reputation tracking fixes

**Test these**:
- [ ] Voice call → AI proposal generation → verify ai_run_id preserved
- [ ] Edit proposal via voice → verify ai_run_id doesn't revert to old run
- [ ] Review proposal → create review response proposal → verify tracing
- [ ] Check reputation score flows end-to-end
- [ ] Verify AI runs appear in call history with correct metadata

**Risk**: If ai_run_id lost, AI traceability audit trail broken

---

### 3. RLS & Tenant Isolation (PR #1830, #1828, #1826)
**What changed**: Seed CLI, tenant deprovision, billing, calendar, public intake all fixed

**Test these**:
- [ ] Create account (tenant A) → create data (estimate, appointment)
- [ ] Create second account (tenant B) → verify cannot see Tenant A's data
- [ ] Change admin settings in Tenant A → verify Tenant B not affected
- [ ] Try URL manipulation to access Tenant B's estimate → blocked with 403
- [ ] Billing reconciliation page → verify shows only current tenant's data
- [ ] Public intake form → verify correct tenant isolation

**Risk**: CRITICAL — data leakage between customers

---

### 4. Voice Quality & Telephony (PR #1829, voicemail handling)
**What changed**: Deploy diagnostics, voicemail Twilio copy handling, call reliability

**Test these**:
- [ ] Inbound call → connects, voice clarification works, ends cleanly
- [ ] Voicemail left during call failure → message stored correctly
- [ ] Call during deploy → should restart gracefully (may drop, then reconnect)
- [ ] Voicemail redelivery after DB outage → message queued and retried
- [ ] Check voicemail page displays all messages correctly

**Risk**: If voicemail lost, customer callbacks missed

---

### 5. Token Bucket / AI Limits (PR #1831, #1829)
**What changed**: Classify/standard token bucket sizing for live load

**Test these**:
- [ ] Rapid voice calls (3+ in quick succession) → rate limiting works correctly
- [ ] Long conversation (10+ turns) → token counting accurate
- [ ] Check monitoring dashboard shows gateway_llm_call_in_transaction_total metric
- [ ] Verify classify token usage matches expected counts

**Risk**: If sizing wrong, gateway timeouts or over-spending

---

## Medium-Risk Areas (Quality Improvements)

### 6. Reputation & Review System (PR #1832, fixes)
**What changed**: Review response proposals traced to runs, customer name fencing

**Test these**:
- [ ] Generate review response proposal via voice → ai_run_id preserved
- [ ] Customer name in review appears correctly (private vs public)
- [ ] Reputation score calc after review → correct
- [ ] Multiple reviews → no cross-customer contamination

---

### 7. Demo Reset & Tenant Provisioning
**What changed**: Demo resets, seed CLI, deprovision now run under RLS

**Test these**:
- [ ] Run demo reset → all data cleared correctly
- [ ] Reprovision tenant → settings, data restored
- [ ] Multiple resets → consistent state

---

## Low-Risk Areas (Maintenance)

### 8. CI/Deploy Diagnostics
**What changed**: Railway CLI stdout logging improvements

**Status**: ✅ CI/infrastructure only, not customer-facing

---

## Known Issues (Still Present, Not Fixed)

| Issue | Severity | Impact |
|-------|----------|--------|
| E1 follow-up task (no callMeBackRepo) | 🔴 CRITICAL | Emergency callbacks may be lost |
| Transfer/escalation (no setPendingTransferTwiml) | 🔴 HIGH | Escalated calls won't dial |
| Disclosure timeout | 🟡 MEDIUM | Intermittent call drops |
| TTS non-PCM fallback | 🟡 MEDIUM | Poor audio quality in fallback |

---

## Testing Checklist

- [ ] **Pre-flight**: Build clean, types pass, no uncommitted changes
- [ ] **Audit/Webhooks**: Events recorded, PII not exposed
- [ ] **AI Traceability**: ai_run_id preserved through edits
- [ ] **RLS/Tenant**: Cross-tenant data blocked
- [ ] **Voice Quality**: Calls connect, voicemail stored, reconnect after deploy
- [ ] **Rate Limiting**: Token buckets working correctly
- [ ] **Review System**: Reputation flows end-to-end
- [ ] **No regressions**: Known issues unchanged (still broken as before)

---

## If Any NEW Issues Found

🚨 **CRITICAL**: Document:
1. **What changed** — which commit/PR introduced it?
2. **Exact repro steps** — how to see the failure
3. **Impact** — does it affect shipping?
4. **Compare to 2026-10-20** — is this new or pre-existing?

---

**Status**: Awaiting automated test completion. Manual testing will focus on areas above.

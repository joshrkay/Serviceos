# QA Comparison Rules — 2026-10-27 vs 2026-10-20

**Purpose**: Brutally honest regression detection with hard rules

---

## Regression Classification Rules

### Rule 1: Same Bug, Same Count
**If issue X appeared N times in 2026-10-20 logs, and appears N times in 2026-10-27 logs:**
- Classification: 🟡 **UNCHANGED** (not a regression)
- Action: Track but don't treat as new failure

**Example**:
- 2026-10-20: "E1 follow-up task NOT created" appeared 6+ times
- 2026-10-27: "E1 follow-up task NOT created" appears 6+ times
- Result: 🟡 SAME STATE (not a regression, expected)

---

### Rule 2: New Bugs (NEW REGRESSION)
**If any error appears in 2026-10-27 logs that didn't appear in 2026-10-20:**
- Classification: 🔴 **NEW REGRESSION**
- Action: IMMEDIATE ESCALATION — determine root cause
- Requirement: Trace commit that introduced it

**Example**:
- 2026-10-20: No "invalid_proposal_state" errors
- 2026-10-27: "invalid_proposal_state" appears 3+ times
- Result: 🔴 NEW REGRESSION (must investigate)

---

### Rule 3: Fixed Bugs
**If issue X appeared in 2026-10-20 logs but doesn't appear in 2026-10-27:**
- Classification: ✅ **FIXED**
- Action: Verify the fix is deliberate and stable

**Example**:
- 2026-10-20: "pool_exhaustion_timeout" appeared 2 times
- 2026-10-27: Zero occurrences
- Result: ✅ LIKELY FIXED (if intentional commit exists)

---

### Rule 4: Unchanged Known Issues
**If pre-existing broken issues remain in same state:**
- Classification: ⚠️ **KNOWN ISSUE** (not a regression)
- Action: Document state, track but don't block release

**Known Issues Expected to Remain Broken**:
- E1 follow-up task (no callMeBackRepo wired) — 🔴 CRITICAL
- Transfer/escalation (no setPendingTransferTwiml) — 🔴 HIGH
- Disclosure timeout (intermittent) — 🟡 MEDIUM
- TTS non-PCM fallback — 🟡 MEDIUM
- On-call repos (test-only) — 🟡 LOW

---

### Rule 5: No Sugar-Coating
**Every finding must be:**
- Honest about actual state
- Grounded in evidence (log evidence, test failure, repro steps)
- Compared explicitly to prior run
- Not aspirational or hoped-for fixes

---

## Test Failure Interpretation

### Automated Test Failures
| Pattern | Meaning | Action |
|---------|---------|--------|
| **Same test fails both runs** | Pre-existing issue | Track, don't treat as new |
| **New test fails** | Regression | Find the commit |
| **Test previously failed, now passes** | Fixed | Verify the fix |
| **Test passes both runs** | Healthy | No action |

---

## Log Evidence Standards

### What counts as evidence?
✅ **Counts**:
- JSON log entries with timestamp and level
- Test output showing failure reason
- Database query showing incorrect result
- Network request showing wrong status code

❌ **Doesn't count**:
- "It seems like..."
- "Probably..."
- "I think there's an issue..."
- Speculation without logs

---

## Specific Checks for 568 Commits

### Audit Events (PR #1835)
**Must verify**:
- [ ] audit_events table receives inserts (check test logs for INSERT calls)
- [ ] audit_events in webhook_events table has correct payload_allowlist
- [ ] No duplicate entries created

**If broken**: Database integrity issue

---

### Webhook PII Minimization (PR #1834)
**Must verify**:
- [ ] webhook_events.payload doesn't contain customer credit card digits
- [ ] webhook_events.payload doesn't contain customer SSN
- [ ] webhook_events.payload contains only allowlisted fields

**If broken**: Privacy/compliance violation

---

### AI Run Traceability (PR #1832)
**Must verify**:
- [ ] ai_run_id preserved when proposal edited via voice
- [ ] Classifier runs findable by ai_run_id
- [ ] Review response proposals reference original run

**If broken**: Audit trail contamination

---

### RLS TFNR Batch 4 (PR #1830)
**Must verify**:
- [ ] Seed CLI owner INSERT runs under rls_app_runtime
- [ ] Clean DELETEs run under rls_app_runtime
- [ ] Cross-tenant queries return 403 not data

**If broken**: CRITICAL data leakage

---

### Voice Voicemail Durability
**Must verify**:
- [ ] Voicemail Twilio copy handled correctly in notify-only branch
- [ ] Orphaned voicemail copies recorded durably
- [ ] Redelivery succeeds after DB outage

**If broken**: Customer voicemail lost

---

## Outcome Summary Format

**For each category**:
```
CATEGORY: [Audit Events | Webhooks | AI Tracing | RLS | Voicemail | ...]
STATUS: [✅ PASS | ⚠️ UNCHANGED | 🔴 NEW REGRESSION]
EVIDENCE: [Specific log lines or test results]
COMPARISON: [vs 2026-10-20 state]
ACTION: [None | Track | Investigate | Block]
```

---

## Release Gates

### ✅ Safe to Ship
- All automated tests pass
- Zero new regressions
- Pre-existing known issues unchanged

### ⚠️ Conditional (depends on tolerance)
- Pre-existing critical issues still broken (E1, transfer)
- Acceptable if acknowledged by product

### 🔴 BLOCK Release
- New regression found
- Data corruption detected
- Privacy/security violation
- RLS bypass confirmed

---

**This framework ensures we catch real problems, not false alarms.**

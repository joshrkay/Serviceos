# RIVET_FOUNDATION_SPEC — Company Setup & Scheduling

**Companion to `.rivet/RIVET_GOAL_PRODUCTION_v2.md` and `.rivet/RIVET_OPERATION_CONTRACTS.md`.**
Those documents define the voice gate. This one defines the **foundation gate**: the
configuration surface that every voice operation silently depends on, and the scheduling
core that consumes it.

**Why one spec.** Setup is the input and scheduling is the output. Nearly every scheduling
defect resolves to a config value that was wrong weeks earlier and failed silently.
Verifying the scheduler against clean seed data measures the seed data, not the scheduler —
so this spec verifies both ends of the pipe and, critically, the propagation between them.

**Scope:** registry ops **#9, #11–13, #37–43, #61–62**, the **§5.10 settings surface**, and
**J1 onboarding** (self-serve: contractor completes minimum configuration and answers their
first live call).

**State:** `.rivet/foundation_state.json`

---

## 1. Goal Statement

> A contractor completes minimum configuration and answers their first live call inside
> 15 minutes; every booking respects the full availability intersection; double-booking is
> **structurally impossible** rather than checked for.

---

## 2. Dependency Graph

Configuration flows downhill. A wrong value at a root node fails silently at every leaf.
Arrows read "is consumed by."

```
timezone ──────────────┬─→ business hours (local → UTC ranges)
                       ├─→ datetime_window resolution ("tomorrow 2pm")
                       ├─→ reminders / quiet hours (FUP-001..005, I11)
                       ├─→ reporting day/week boundaries
                       └─→ recurring series materialization (#18)

business hours ────────┬─→ availability intersection (§4, term 1)
                       └─→ after-hours voice behavior

tech working hours ─────→ availability intersection (term 2)
existing assignments ───→ availability intersection (term 3, incl. travel buffer)
travel buffer config ───→ availability intersection (term 3)
PTO / time off ─────────→ availability intersection (term 4)
service area ───────────→ availability intersection (term 5)
skills / service types ─→ availability intersection (term 6)

price book ─────────────→ estimates, invoices (catalog-resolver grounding)
tax settings ───────────→ invoice totals
Stripe Connect KYC ─────→ payment collection (S-4)
10DLC campaign ─────────→ all customer SMS (S-5, FUP-*)
```

**Timezone is the root.** It is stored once and consumed in at least six places. A consumer
that misses it — doing naive UTC math, or reading server time — produces answers that are
correct for eight months a year and wrong by an hour at the two DST boundaries. This is why
V15 exists and why it must run against a DST-observing zone deliberately (most of Arizona
skips DST; local tenants will never reproduce these bugs).

---

## 3. Staged Onboarding (J1)

Onboarding is **staged, not gated**. Each stage is independently useful; completing S-1
delivers value even if S-5 never happens. The product must state, at every stage, what is
unlocked and what is not — a tenant who can't text customers because 10DLC is pending
should learn that from the product, not from a customer complaint.

| Stage | Name | Minimum configuration | Unlocks | External clock |
|---|---|---|---|---|
| **S-1** | Answer | business name, timezone, business hours, greeting | inbound calls answered, messages taken | none |
| **S-2** | Book | ≥1 tech + working hours, service area, ≥1 service type, travel buffer | live booking on inbound calls, operator scheduling | none |
| **S-3** | Bill | price book rates, tax settings | estimates and invoices | none |
| **S-4** | Collect | Stripe Connect KYC cleared | payment links, card payment | Stripe (days, variable) |
| **S-5** | Automate | 10DLC brand + campaign approved | reminders, follow-ups, all outbound SMS | carriers (weeks) |

Rules:

- **S-1 target: ≤15 minutes** from signup to first answerable call. This is the
  time-to-first-value metric the product competes on.
- Stages unlock independently. S-4 pending does not block S-2 booking; S-5 pending does not
  block S-3 invoicing (delivery falls back to email or is queued with an explicit banner).
- A stage's state is **derived from configuration present**, not from a wizard step counter.
  A tenant who configures out of order still gets correct unlock state.
- Every operation belonging to a locked stage degrades **informatively** (§7): it names the
  missing configuration and the stage that supplies it. Never a 500, never silence, never
  undefined behavior.

---

## 4. The Availability Model

Availability is a **six-way intersection**. A slot is offerable for (tech, window) iff all
six hold:

```
1. window ⊆ business hours            (tenant-local, tz-resolved)
2. window ⊆ tech working hours        (tech-local schedule for that weekday)
3. no assignment overlap              including travel buffer on both flanks
4. tech not on PTO / time off         for any part of window
5. job site inside service area
6. tech holds required skill          for the service type (when skills are modeled)
```

Any one term wrong yields **confidently incorrect** answers — the scheduler doesn't error,
it books a job the truck can't reach or a tech who isn't there. Each term therefore needs
its own falsification test (a candidate slot that fails *only* that term must be rejected),
not just a happy-path pass.

**Travel buffer is mandatory, not optional polish.** Two jobs 45 minutes apart cannot be
back-to-back. A schedule computed without buffer is valid on paper and impossible in a
truck. Buffer applies to term 3: an existing assignment blocks
`[start − buffer, end + buffer]`, not `[start, end]`.

**The intersection is advisory; the constraint is authoritative.** Availability computation
races with concurrent booking by construction (concurrent inbound call + operator booking
is this product's normal operating mode). The intersection filters candidates; the database
constraint (§5) is what makes the final booking safe.

---

## 5. Double-Booking Is a Database Constraint

**Non-negotiable.** `SELECT → decide → INSERT` has a race window, and no application-level
check closes it. The constraint:

```sql
ALTER TABLE appointment_assignments
  ADD CONSTRAINT no_double_booking
  EXCLUDE USING gist (
    tenant_id WITH =,
    technician_id WITH =,
    tstzrange(scheduled_start, scheduled_end) WITH &&
  )
  WHERE (appointment_status NOT IN ('canceled', 'no_show'));
```

Rules:

- The app handles exclusion violation (Postgres **23P01**) as an **ordinary branch** — it
  re-computes availability and offers the next slot, or reports the collision. It never
  retries the same insert, never pre-checks-then-inserts as its safety mechanism, and never
  surfaces a raw constraint error to a caller.
- Every write path that creates or moves an assignment (#9 create_scheduled, #11
  reschedule, #12/#13 assign/reassign, #39 move_appointment, #18 recurring
  materialization) goes through the constraint. No path bypasses `appointment_assignments`.
- **The constraint's existence is verified, not assumed.** The schema bootstrap skips the
  constraint (RAISE WARNING) if pre-existing overlapping rows are present at deploy time.
  That skip is a deliberate deploy-safety valve, and it means a live database can lack the
  constraint. F3 therefore checks the constraint is present in the target database
  (`pg_constraint`), and the check runs before everything else — without it, F1 passing is
  an artifact of low test concurrency.
- Travel buffer is **not** in the constraint (the constraint guards physical overlap; the
  buffer is a quality property of the availability computation). F2 covers buffer; F1/F3
  cover overlap.

---

## 6. Settings Propagation (§5.10)

Read-after-write proves storage, not propagation. Every **Critical** setting (per
`RIVET_OPERATION_CONTRACTS.md` §5.10: business hours, timezone, price book, voice agent
config, messaging templates/cadence, payment settings, tax settings) requires one test
proving a **downstream operation observes the change**:

| Setting | Downstream proof |
|---|---|
| timezone | same wall-clock request yields shifted UTC slots; quiet-hours boundary moves |
| business hours | slot offered yesterday is rejected after hours shrink |
| tech working hours | availability loses/gains slots for that tech |
| travel buffer | adjacent slot appears/disappears as buffer changes |
| service area | in-area address becomes out-of-area after area shrinks |
| price book rate | next drafted line item carries the new rate |
| tax rate | next invoice total reflects the new rate |
| quiet hours / cadence | FUP send suppressed/permitted across the boundary |

Settings writes carry the I12 contract: audit with prior value, single-step revert,
confirmation before commit for Critical rows.

---

## 7. Cold Tenant (V18)

A freshly created tenant with zero configuration exercises every missing-config path at
once. For **all 62 registry operations** plus availability and booking, a cold tenant must
degrade **informatively**:

- The error names the missing configuration and the onboarding stage that supplies it
  ("No business hours configured — complete setup step 1 to accept bookings").
- No operation 500s, hangs, returns empty results indistinguishable from "fully booked,"
  or silently applies a default the tenant never chose.
- Defaults that *are* applied (e.g., a default travel buffer) are explicit, documented in
  the settings surface, and auditable.

Cold-tenant behavior is the product stating its own dependency graph back to the user.

---

## 8. Validation Vectors

Extends the V1–V11 taxonomy in `RIVET_OPERATION_CONTRACTS.md` §4:

| ID | Vector | Discipline |
|---|---|---|
| **V15** | Timezone / DST | Run every time-sensitive assertion against **both** a DST-observing tenant (e.g. `America/New_York`) and a non-observing tenant (`America/Phoenix`), including dates that straddle the spring-forward and fall-back boundaries. Nonexistent local times (2:30am on spring-forward day) and ambiguous ones (1:30am on fall-back day) must resolve deterministically, not crash. |
| **V16** | Concurrency under real contention | N genuinely parallel bookings race for one slot (distinct connections, overlapping transactions). Exactly one wins; every loser gets the ordinary-branch handling of §5. **Sequential tests do not satisfy V16** — a loop of awaited inserts never opens the race window and proves nothing about it. |
| **V17** | Setting propagation | The §6 table. Write the setting through the real settings path (not direct SQL), then observe the downstream operation change behavior. |
| **V18** | Cold tenant | §7, across the full operation surface. |

---

## 9. Gates

| | Condition | Type |
|---|---|---|
| **F1** | Zero double-bookings under V16 contention | **binary** |
| **F2** | Zero jobs outside the six-way intersection (each term falsified independently, buffer included) | **binary** |
| **F3** | Overlap exclusion enforced at the DB level — constraint present in `pg_constraint`, violation handled as ordinary branch | **binary** |
| **F4** | V15 clean — DST and non-DST tenants, boundary dates included | quality |
| **F5** | Time-to-first-call ≤ 15 min; S-1..S-5 each independently functional with unlock state correctly reported | quality |
| **F6** | Every Critical setting propagation-tested (V17 table complete) | quality |
| **F7** | Cold tenant degrades informatively on all 62 ops (V18) | quality |

F1–F3 are binary invariants: any regression halts the loop immediately, same posture as
P3/P4 in the production gate.

---

## 10. The Loop

```
1  CONSTRAINT CHECK  [Haiku]   F3 — constraint present in target DB? absent → HALT
2  GATE CHECK        [Haiku]   F1–F7; all clean → CONVERGED
3  VERIFY            [Opus V15/V16 · Sonnet rest]   failing areas only
4  REMEDIATE         [Sonnet]
5  VALIDATE          [Haiku]   re-run affected areas + V16 contention always
6  CONVERGE          F1/F2/F3 regression → HALT NOW
                     passing count flat 2 iterations → HALT
                     iteration ≥ 6 → HALT
```

Step 1 precedes the gate check deliberately: without the exclusion constraint, F1 passing
is an artifact of low test concurrency, and every downstream result is noise.

---

## 11. Command Surface

| Command | Effect |
|---|---|
| `/goal foundation` | Full convergence loop |
| `/goal foundation onboard` | J1 / S-1..S-5 verification only (F5) |
| `/goal foundation schedule` | Availability intersection + booking ops (F2) |
| `/goal foundation concurrency` | V16 contention run (F1/F3) |
| `/goal foundation propagate` | V17 settings propagation (F6) |
| `/goal foundation cold` | V18 cold tenant sweep (F7) |
| `/goal foundation status` | Read state, report, no action |

---

## Appendix A — Code Pinning

Populated by survey against the working tree; re-pin when files move.

*(filled by the foundation loop — see `.rivet/foundation_state.json` `evidence` for the
current pinning and test-suite mapping)*

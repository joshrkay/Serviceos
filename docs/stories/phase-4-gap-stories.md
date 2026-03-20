# Phase 4 — Vertical Packs + Estimate Intelligence: Launch Readiness Gaps

> **2 stories** | Continues from P4-012

---

## Purpose

Phase 4 is largely complete — vertical packs, terminology, templates, bundles, and context assembly are all implemented. The remaining gaps are UI wiring: connecting the onboarding flow to the backend and making template management accessible in settings.

## Exit Criteria

New tenants select their vertical pack during onboarding and it persists to the backend; templates are viewable and manageable from the settings page.

## Gap Summary

| ID | Title | Size | Layer | AI Build | Human Review | Dependencies |
|----|-------|------|-------|----------|--------------|-------------|
| P4-013 | Wire onboarding vertical pack selection to backend | S | Settings/UI | High | Moderate | P0-022, P0-029, P4-001B |
| P4-014 | Template management UI in settings | S | Settings/UI | High | Moderate | P0-022, P4-004B |

---

## Story Specifications

### P4-013 — Wire onboarding vertical pack selection to backend

> **Size:** S | **Layer:** Settings/UI | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P0-022, P0-029, P4-001B

**Allowed files:** `packages/web/src/components/onboarding/**, packages/api/src/routes/settings.ts, packages/api/src/routes/pack-activation.ts`

**Build prompt:** The OnboardingPage has a functional multi-step form that collects vertical selection (HVAC, Plumbing), team size, terminology preferences, and AI automation settings. Currently this data is saved to local state only — it doesn't persist to the backend. Wire it: (1) After onboarding completes, call `POST /api/settings` with business profile data. (2) Call `POST /api/settings/pack-activation` with selected vertical packs. (3) Call `PATCH /api/settings` with terminology preferences. (4) Mark the tenant as onboarded (flag in settings). (5) On subsequent logins, skip onboarding if already completed.

**Review prompt:** Verify all onboarding data persists to the API. Verify onboarding is skipped for returning users. Verify pack activation creates the correct vertical pack records. Verify terminology preferences are saved. Check error handling — if any API call fails, allow retry without data loss.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P4-013"
```

**Required tests:**
- [ ] Happy path — complete onboarding, data persisted
- [ ] Pack activation — selected packs activated for tenant
- [ ] Skip — returning user bypasses onboarding
- [ ] Partial failure — retry without re-entering data
- [ ] Multiple packs — HVAC + Plumbing both activated

---

### P4-014 — Template management UI in settings

> **Size:** S | **Layer:** Settings/UI | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P0-022, P4-004B

**Allowed files:** `packages/web/src/components/settings/**, packages/api/src/routes/templates.ts`

**Build prompt:** The TemplatesPage exists in settings but needs to be wired to the backend. Implement: (1) List available estimate templates filtered by the tenant's active vertical packs via `GET /api/templates?vertical=hvac`. (2) Preview a template's line items and structure. (3) Allow owners to customize template wording (not structure) via `PATCH /api/templates/:id`. (4) Show which templates were used most recently. The backend template routes already exist — this is primarily frontend wiring.

**Review prompt:** Verify templates are filtered by active vertical pack. Verify template preview renders line items correctly. Verify wording customization persists. Verify only owners can edit templates (RBAC). Check that templates show their vertical association clearly.

**Automated checks:**
```bash
npx tsc --noEmit
npm test -- --grep "P4-014"
```

**Required tests:**
- [ ] Happy path — templates listed by vertical
- [ ] Preview — template line items rendered
- [ ] Edit wording — custom wording saved and loaded
- [ ] Filter — only active pack templates shown
- [ ] Permission — non-owner cannot edit templates

# Phase 13 (Account Depth) — Multi-Agent Dispatch Addendum

## Wave plan

| Wave | Stories | Run-mode | Blocks |
|---|---|---|---|
| 13A | P13-001 | single agent (touches Customer interface — wide blast radius) | unlocks 13B |
| 13B | P13-002, P13-003 | parallel (different domains; both touch Customer interface but additively only) | sprint complete |

P13-001 ships first because it modifies `Customer` interface (adds `contactsCount?`). 13B stories also extend Customer/Lead/Job interfaces (additive: `tags?`, `customFields?`). Branching 13B from post-13A main avoids interface-drift conflicts.

## Migration ledger

- 067: P13-001 `customer_contacts`
- 157: P13-002 `equipment` + `equipment_service_log`
- 069: P13-003 `tags` + `entity_tags` + `tenant_custom_field_definitions` + ALTERs

---

## P13-001 — Multiple contacts per customer

**Wave:** 13A
**Migration number reserved:** 067
**Forbidden files:**
- `packages/api/src/db/pg-base.ts`
- `packages/shared/**`
- `packages/api/src/auth/rbac.ts`
- `packages/web/src/components/auth/**`
- `packages/api/src/leads/**` (separate entity; don't conflate)

**Allowed files:** as listed in story.

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  (cd packages/api && npx tsc --project tsconfig.build.json --noEmit) && \
  (cd packages/api && npm test -- -t "contact|customer-contact|P13-001") && \
  (cd packages/web && npm test -- --run -t "Contact|P13-001")
```

**Risk note:**
- **`Customer` interface change**: adding `contactsCount?: number` is Tier-2 additive; verify no consumers spread Customer expecting only existing fields.
- **Max-1-primary**: enforce via partial unique index, not just app logic.
- **SMS consent default false**: must opt-in explicitly.

**Implementation hints:**
1. Mirror `packages/api/src/leads/lead.ts` for repo + service shape.
2. UI: ContactList in a new Contacts tab on CustomerDetail; ContactForm is a slide-over modal.
3. `contactsCount` computed via subquery in pg-customer.findById; OK to return undefined for now if perf concern.

---

## P13-002 — Equipment / asset registry

**Wave:** 13B
**Migration number reserved:** 157
**Forbidden files:**
- `packages/api/src/db/pg-base.ts`
- `packages/shared/**`
- `packages/api/src/customers/**` (READ ONLY — equipment links via customer_id)
- `packages/api/src/locations/**` (READ ONLY)
- `packages/api/src/jobs/**` (READ ONLY — service-log links via job_id)
- `packages/api/src/auth/rbac.ts`
- `packages/web/src/components/auth/**`

**Allowed files:** as listed in story.

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  (cd packages/api && npx tsc --project tsconfig.build.json --noEmit) && \
  (cd packages/api && npm test -- -t "equipment|P13-002") && \
  (cd packages/web && npm test -- --run -t "Equipment|P13-002")
```

**Risk note:**
- **Service-log scale**: cap query at 200 rows per equipment.
- **Voice intent classifier**: adding `lookup_equipment` requires touching the system prompt's lookup block — keep additions confined to the lookup section.
- **LocationDetail page**: only modify if file exists; otherwise skip and document in PR.

**Implementation hints:**
1. Mirror `packages/api/src/agreements/` (P9-003) for the dual-table repo pattern.
2. Voice skill: mirror `lookup-account-summary.ts` aggregation pattern.

---

## P13-003 — Tags + custom fields

**Wave:** 13B
**Migration number reserved:** 069
**Forbidden files:**
- `packages/api/src/db/pg-base.ts`
- `packages/shared/**`
- `packages/api/src/auth/rbac.ts`
- `packages/web/src/components/auth/**`
- `packages/api/src/equipment/**` (P13-002 owns; tag support for equipment is a follow-up)

**Allowed files:** as listed in story.

**Verification gate:**
```bash
cd /home/user/Serviceos && \
  (cd packages/api && npx tsc --project tsconfig.build.json --noEmit) && \
  (cd packages/api && npm test -- -t "tag|custom-field|P13-003") && \
  (cd packages/web && npm test -- --run -t "Tag|CustomField|P13-003")
```

**Risk note:**
- **Denorm sync**: writing entity_tags also updates the denormalized `tags TEXT[]` column on customers/leads/jobs. Use a single transaction.
- **Custom field validation**: server validates the value type matches the tenant's defined field_type. Reject mismatches with 400.
- **Max tags per entity**: cap at 20. UI should disable add button at limit.
- **Tier-2 additive**: `tags?` and `customFields?` are optional fields on existing interfaces — Tier-2 stable-with-extensions.

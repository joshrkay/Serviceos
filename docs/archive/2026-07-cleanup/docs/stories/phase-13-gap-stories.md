# Phase 13 — Account Depth: B2B + Vertical Specialization

> **3 stories** | Multiple contacts, equipment registry, tags + custom fields

---

## Purpose

Service businesses serving commercial accounts (property managers, REITs, hotels, restaurants) and equipment-heavy verticals (HVAC, plumbing, pool, appliance) need account depth that residential CRMs ignore. Phase 13 ships:

- **Multiple contacts per customer** — decision-maker / billing / on-site / emergency, each with own channel preferences
- **Equipment / asset registry** — what's installed at each location, model/serial/warranty/install date, service history per unit
- **Tags + custom fields** — taxonomy + metadata for segmentation, automation triggers, reporting slices

## Exit Criteria

Owner adds 3 contacts to a commercial account (decision-maker, AP, on-site manager). Voice agent calling that customer recognizes "billing question" and routes to AP contact. Equipment registry shows the HVAC condenser installed Jan 2024 with 9-year warranty + last serviced Aug 2025. A "VIP" tag floats the customer to top of dashboards. A custom field "Building access code: 4271" appears on tech mobile view.

## Foundations already in place

- `packages/api/src/customers/customer.ts` — Customer interface (P13-001 extends Tier-2 stable-with-extensions)
- `packages/api/src/locations/location.ts` — service location (P13-002 references)
- `packages/api/src/notes/note.ts` — pattern for entity-attached metadata
- `packages/api/src/ai/skills/lookup-*.ts` — pattern for `lookup_equipment` voice skill (P13-002)

---

## Story Specifications

### P13-001 — Multiple contacts per customer

> **Size:** M | **Layer:** CRM | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** none

**Allowed files:** `packages/api/src/customers/contact.ts, packages/api/src/customers/pg-contact.ts, packages/api/src/customers/contact-service.ts, packages/api/src/customers/customer.ts (additive: contactsCount?: number for UI badge), packages/api/src/customers/pg-customer.ts (compute contactsCount in findById/findByTenant), packages/api/src/routes/customer-contacts.ts, packages/api/src/db/schema.ts (migration 067 only), packages/api/src/app.ts (wiring only), packages/api/src/customers/__tests__/contact.test.ts, packages/api/test/customers/contact.test.ts, packages/api/test/customers/contact-routes.test.ts, packages/web/src/pages/customers/CustomerContacts.tsx, packages/web/src/components/customers/ContactList.tsx, packages/web/src/components/customers/ContactForm.tsx, packages/web/src/pages/customers/CustomerDetail.tsx (add contacts section only), packages/web/src/components/customers/__tests__/**, packages/web/src/api/customer-contacts.ts`

**Build prompt:** (1) Migration `067_create_customer_contacts`: `id, tenant_id, customer_id (FK), name, role (enum: decision_maker, billing, on_site, emergency, primary, other), phone, email, sms_consent BOOL DEFAULT false, email_consent BOOL DEFAULT true, preferred_channel TEXT, notes, is_primary BOOL DEFAULT false, created_by, created_at, updated_at`. RLS. Index on (tenant_id, customer_id). Partial unique index on (tenant_id, customer_id) WHERE is_primary = true (max 1 primary per customer). (2) Repo + service following Phase 9 conventions. Service exposes CRUD + `findByCustomer(tenantId, customerId)` + `findByRole(tenantId, customerId, role)`. (3) Routes: `POST /api/customers/:id/contacts`, `GET /api/customers/:id/contacts`, `PATCH /api/customers/:id/contacts/:contactId`, `DELETE` (soft via is_archived if pattern matches; else hard delete). (4) Customer interface gets optional `contactsCount?: number` (additive — Tier-2 stable-with-extensions). Pg findById computes via subquery. (5) Web: ContactList (table with role badges), ContactForm (modal), mounted on CustomerDetail in a new "Contacts" section.

**Voice integration (light):** When voice agent identifies caller as customer X and the intent is `lookup_invoices`/`record_payment`, prefer the `billing` contact's preferred_channel for any follow-up. Add this in a single line in lookup-invoices.ts (READ ONLY on lookup-invoices — actually this is an extension). Defer to Phase 14 if scope creeps.

**Review prompt:** Verify role enum complete. Verify max-1-primary constraint. Verify SMS consent honored. Verify contactsCount accurate. Verify tenant isolation.

**Required tests:** create with role; max-1-primary enforced; findByRole returns only matching; consent flags persist; tenant isolation; UI form validates phone/email format.

---

### P13-002 — Equipment / asset registry

> **Size:** L | **Layer:** CRM | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P13-001 (use customer-contact for warranty alerts) — soft

**Allowed files:** `packages/api/src/equipment/**, packages/api/src/routes/equipment.ts, packages/api/src/ai/skills/lookup-equipment.ts, packages/api/src/ai/orchestration/intent-classifier.ts (add lookup_equipment intent only), packages/api/src/db/schema.ts (migration 068 only), packages/api/src/app.ts (wiring only), packages/api/src/equipment/__tests__/**, packages/api/test/equipment/**, packages/api/test/ai/skills/lookup-equipment.test.ts, packages/web/src/pages/equipment/**, packages/web/src/components/equipment/**, packages/web/src/api/equipment.ts, packages/web/src/pages/customers/CustomerDetail.tsx (add equipment section), packages/web/src/pages/locations/LocationDetail.tsx (add equipment section if file exists; create if not — but ONLY if it exists; otherwise skip the location-detail integration)`

**Build prompt:** (1) Migration `068_create_equipment`: TWO tables.

`equipment`: `id, tenant_id, customer_id (FK), location_id (FK, nullable), name (e.g. "Carrier 24ACC6 Condenser"), category (enum: hvac, plumbing, electrical, pool, appliance, other), make, model, serial_number, install_date, warranty_expires_at (nullable), purchase_price_cents BIGINT (nullable), notes, is_active BOOL DEFAULT true, created_by, created_at, updated_at`. RLS. Indexes on (tenant_id, customer_id), (tenant_id, location_id), (tenant_id, warranty_expires_at) for warranty-expiry alerts.

`equipment_service_log`: `id, tenant_id, equipment_id (FK), job_id (nullable FK — link to job that did the service), service_type (enum: install, repair, maintenance, inspection, removed), service_date, performed_by_user_id, notes, parts_replaced (text — to be replaced by structured FK in Phase 14), created_at`. RLS. Index on (tenant_id, equipment_id, service_date desc).

(2) Repos + services following Phase 9 conventions. (3) Routes: full CRUD on /api/equipment + nested /api/equipment/:id/service-log. (4) Voice skill `lookup-equipment.ts`: takes (tenantId, customerId), returns active equipment with last service date + next-due-by-warranty. Add to intent-classifier with 5 phrasings ("what HVAC unit is at this house", "when did we install the heater"). (5) Web: EquipmentList, EquipmentDetail (with service-log timeline), EquipmentForm. Mount on CustomerDetail and LocationDetail (latter only if file exists).

**Review prompt:** Verify location_id is nullable (some equipment is portable). Verify service-log query is fast for 200+ rows (proper index). Verify warranty_expires_at index supports the alert query. Verify voice skill returns TTS-friendly summary.

**Required tests:** equipment CRUD; service-log append; tenant isolation; warranty-expiry query returns sorted; voice skill returns summary; intent classifier routes "what equipment" to lookup_equipment.

---

### P13-003 — Tags + custom fields framework

> **Size:** M | **Layer:** CRM | **AI Build:** Medium | **Human Review:** Heavy

**Dependencies:** P13-001 (so contacts can be tagged too — soft)

**Allowed files:** `packages/api/src/tags/**, packages/api/src/custom-fields/**, packages/api/src/routes/tags.ts, packages/api/src/routes/custom-fields.ts, packages/api/src/db/schema.ts (migration 069 only), packages/api/src/app.ts (wiring only), packages/api/src/customers/customer.ts (additive tags?: string[], customFields?: Record<string,unknown>), packages/api/src/customers/pg-customer.ts (read/write the new column), packages/api/src/leads/lead.ts (same additive), packages/api/src/leads/pg-lead.ts (same), packages/api/src/jobs/job.ts (same additive), packages/api/src/jobs/pg-job.ts (same), packages/api/test/tags/**, packages/api/test/custom-fields/**, packages/web/src/pages/settings/TagsSettings.tsx, packages/web/src/pages/settings/CustomFieldsSettings.tsx, packages/web/src/components/tags/TagPicker.tsx, packages/web/src/components/tags/TagBadge.tsx, packages/web/src/components/custom-fields/CustomFieldRenderer.tsx, packages/web/src/components/__tests__/**, packages/web/src/api/tags.ts, packages/web/src/api/custom-fields.ts`

**Build prompt:** (1) Migration `069_create_tags_and_custom_fields`:

`tags`: `id, tenant_id, label, color (hex), entity_types TEXT[] (e.g. {customer,job,lead}), created_at`. UNIQUE (tenant_id, label).

`entity_tags`: `id, tenant_id, tag_id (FK), entity_type, entity_id, created_at`. UNIQUE (tenant_id, tag_id, entity_type, entity_id).

`tenant_custom_field_definitions`: `id, tenant_id, entity_type (customer|lead|job), key, label, field_type (enum: text, number, boolean, date, single_select, multi_select), options JSONB (for selects), is_required BOOL DEFAULT false, sort_order INT, created_at`.

ALTER customers/leads/jobs tables: add `tags TEXT[] DEFAULT '{}'`, `custom_fields JSONB DEFAULT '{}'`. (Tags duplicated as denormalized column for fast filter queries; entity_tags is source of truth.)

(2) Service: `setEntityTags(tenantId, entityType, entityId, tagIds)` writes to entity_tags + updates denorm column. `defineCustomField(tenantId, entityType, def)`. `setCustomField(tenantId, entityType, entityId, key, value)` validates against tenant's schema. (3) Routes: full CRUD on tags, custom-field-definitions, entity-tag attach/detach. (4) Customer/Lead/Job interfaces gain `tags?: string[]` and `customFields?: Record<string, unknown>` (Tier-2 additive). (5) Web: settings pages for tag taxonomy + custom field definitions; TagPicker/TagBadge components, CustomFieldRenderer (renders the right input per field_type), mounted on detail pages where applicable.

**Review prompt:** Verify denorm column stays in sync with entity_tags (or document the staleness window). Verify custom_fields JSONB is validated against tenant schema on write. Verify tag color is hex-validated. Verify max tags per entity (cap at 20).

**Required tests:** tag CRUD; entity-tag attach/detach updates denorm; custom-field schema validation rejects bad type; tenant isolation; max-20-tags enforced.

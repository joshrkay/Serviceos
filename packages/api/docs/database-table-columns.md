# Database Tables and Columns

Source of truth: `packages/api/src/db/schema.ts` migration definitions.


## How to apply these tables/columns to a real database

This file is only an inventory. The actual source of truth is the migration SQL in `packages/api/src/db/schema.ts`.

1. Set your Postgres connection:
   - `export DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/DBNAME`
2. (Optional) Validate migration SQL generation without touching DB:
   - `npm --prefix packages/api run migrate:dryrun`
3. Apply migrations to the target database:
   - `npm --prefix packages/api run migrate:apply` (uses `DATABASE_URL` with ts-node in dev/CI)
   - `DATABASE_URL=... node packages/api/dist/src/db/migrate.js` (compiled runtime path)
   - or during container startup, `packages/api/docker-entrypoint.sh` runs this automatically before starting the API.
4. Verify tables in Postgres:
   - `psql "$DATABASE_URL" -c "\dt"`
   - `psql "$DATABASE_URL" -c "\d+ jobs"` (repeat for any table)

### When you add new columns/tables

- Edit `packages/api/src/db/schema.ts` and add/extend the relevant migration SQL.
- Run `npm --prefix packages/api run migrate:dryrun`.
- Run tests (at minimum `npm --prefix packages/api run test -- test/db/schema.test.ts`).
- Deploy/restart API so migration runner executes against your environment.

## Platform & Auth

- `tenants`: `id`, `owner_id`, `owner_email`, `name`, `created_at`, `updated_at`
- `users`: `id`, `tenant_id`, `clerk_user_id`, `email`, `role`, `first_name`, `last_name`, `created_at`, `updated_at`
- `audit_events`: `id`, `tenant_id`, `actor_id`, `actor_role`, `event_type`, `entity_type`, `entity_id`, `correlation_id`, `metadata`, `created_at`

## Storage & Messaging

- `files`: `id`, `tenant_id`, `filename`, `content_type`, `size_bytes`, `s3_bucket`, `s3_key`, `entity_type`, `entity_id`, `uploaded_by`, `created_at`, `updated_at`
- `conversations`: `id`, `tenant_id`, `title`, `entity_type`, `entity_id`, `status`, `created_by`, `created_at`, `updated_at`
- `messages`: `id`, `tenant_id`, `conversation_id`, `message_type`, `content`, `sender_id`, `sender_role`, `file_id`, `source`, `metadata`, `created_at`
- `voice_recordings`: `id`, `tenant_id`, `file_id`, `conversation_id`, `status`, `transcript`, `transcript_metadata`, `duration_seconds`, `error_message`, `created_by`, `created_at`, `updated_at`

## AI Foundations

- `ai_runs`: `id`, `tenant_id`, `task_type`, `model`, `prompt_version_id`, `input_snapshot`, `output_snapshot`, `status`, `error_message`, `started_at`, `completed_at`, `duration_ms`, `token_usage`, `correlation_id`, `created_by`, `created_at`
- `prompt_versions`: `id`, `task_type`, `version`, `template`, `model`, `is_active`, `metadata`, `created_by`, `created_at`
- `document_revisions`: `id`, `tenant_id`, `document_type`, `document_id`, `version`, `snapshot`, `source`, `actor_id`, `actor_role`, `ai_run_id`, `metadata`, `created_at`
- `diff_analyses`: `id`, `tenant_id`, `document_type`, `document_id`, `from_revision_id`, `to_revision_id`, `diff`, `summary`, `status`, `error_message`, `created_at`

## Webhooks & Settings

- `webhook_events`: `id`, `source`, `event_type`, `idempotency_key`, `payload`, `status`, `error_message`, `processed_at`, `created_at`
- `tenant_settings`: `id`, `tenant_id`, `business_name`, `business_phone`, `business_email`, `timezone`, `estimate_prefix`, `invoice_prefix`, `next_estimate_number`, `next_invoice_number`, `default_payment_term_days`, `terminology_preferences`, `created_at`, `updated_at`

## Core Field Operations

- `customers`: `id`, `tenant_id`, `first_name`, `last_name`, `display_name`, `company_name`, `primary_phone`, `secondary_phone`, `email`, `preferred_channel`, `sms_consent`, `communication_notes`, `is_archived`, `archived_at`, `created_by`, `created_at`, `updated_at`
- `service_locations`: `id`, `tenant_id`, `customer_id`, `label`, `street1`, `street2`, `city`, `state`, `postal_code`, `country`, `latitude`, `longitude`, `access_notes`, `is_primary`, `is_archived`, `archived_at`, `created_at`, `updated_at`
- `jobs`: `id`, `tenant_id`, `customer_id`, `location_id`, `job_number`, `summary`, `problem_description`, `status`, `priority`, `assigned_technician_id`, `created_by`, `created_at`, `updated_at`
- `job_timeline_events`: `id`, `tenant_id`, `job_id`, `event_type`, `from_status`, `to_status`, `description`, `actor_id`, `actor_role`, `metadata`, `created_at`
- `appointments`: `id`, `tenant_id`, `job_id`, `scheduled_start`, `scheduled_end`, `arrival_window_start`, `arrival_window_end`, `timezone`, `status`, `notes`, `created_by`, `created_at`, `updated_at`
- `appointment_assignments`: `id`, `tenant_id`, `appointment_id`, `technician_id`, `is_primary`, `assigned_by`, `assigned_at`

## Estimates

- `estimates`: `id`, `tenant_id`, `job_id`, `estimate_number`, `status`, `discount_cents`, `tax_rate_bps`, `subtotal_cents`, `taxable_subtotal_cents`, `tax_cents`, `total_cents`, `valid_until`, `customer_message`, `internal_notes`, `created_by`, `created_at`, `updated_at`
- `estimate_line_items`: `id`, `tenant_id`, `estimate_id`, `description`, `category`, `quantity`, `unit_price_cents`, `total_cents`, `sort_order`, `taxable`
- `estimate_provenance`: `id`, `tenant_id`, `estimate_id`, `source_type`, `source_reference`, `creator_id`, `creator_role`, `ai_run_id`, `conversation_id`, `metadata`, `created_at`
- `estimate_approvals`: `id`, `tenant_id`, `estimate_id`, `status`, `approved_by`, `approved_at`, `rejected_by`, `rejected_at`, `rejection_reason`, `approved_with_edits`, `final_revision_id`, `metadata`, `created_at`

## Invoices & Payments

- `invoices`: `id`, `tenant_id`, `job_id`, `estimate_id`, `invoice_number`, `status`, `discount_cents`, `tax_rate_bps`, `subtotal_cents`, `taxable_subtotal_cents`, `tax_cents`, `total_cents`, `amount_paid_cents`, `amount_due_cents`, `issued_at`, `due_date`, `customer_message`, `created_by`, `created_at`, `updated_at`
- `invoice_line_items`: `id`, `tenant_id`, `invoice_id`, `description`, `category`, `quantity`, `unit_price_cents`, `total_cents`, `sort_order`, `taxable`
- `payments`: `id`, `tenant_id`, `invoice_id`, `amount_cents`, `status`, `payment_method`, `stripe_payment_intent_id`, `stripe_payment_link_id`, `reference_number`, `notes`, `paid_at`, `created_by`, `created_at`, `updated_at`

## Proposals, Evaluation, and Caching

- `proposals`: `id`, `tenant_id`, `proposal_type`, `status`, `payload`, `confidence_score`, `target_entity_type`, `target_entity_id`, `ai_run_id`, `conversation_id`, `idempotency_key`, `expires_at`, `reviewed_by`, `reviewed_at`, `rejection_reason`, `execution_error`, `created_by`, `created_at`, `updated_at`
- `proposal_analytics`: `id`, `tenant_id`, `proposal_id`, `proposal_type`, `outcome`, `edited_fields`, `rejection_reason`, `confidence_score`, `recorded_at`
- `evaluation_snapshots`: `id`, `tenant_id`, `proposal_id`, `ai_run_id`, `task_type`, `input`, `output`, `outcome`, `captured_at`
- `llm_cache`: `id`, `cache_key`, `tenant_id`, `task_type`, `response`, `ttl_ms`, `cached_at`
- `provider_health`: `id`, `provider_name`, `latency_ms`, `success`, `recorded_at`

## Vertical Packs & Knowledge

- `vertical_packs`: `id`, `type`, `name`, `version`, `description`, `is_active`, `categories`, `terminology`, `created_at`, `updated_at`
- `estimate_templates`: `id`, `tenant_id`, `vertical_type`, `category_id`, `name`, `description`, `line_item_templates`, `default_discount_cents`, `default_tax_rate_bps`, `default_customer_message`, `is_active`, `usage_count`, `created_by`, `created_at`, `updated_at`
- `service_bundles`: `id`, `tenant_id`, `vertical_type`, `name`, `description`, `category_ids`, `line_item_templates`, `trigger_keywords`, `is_active`, `usage_count`, `created_at`, `updated_at`
- `wording_preferences`: `id`, `tenant_id`, `vertical_type`, `scope`, `key`, `preferred_wording`, `avoid_wordings`, `context`, `is_active`, `created_at`, `updated_at`
- `quality_metrics`: `id`, `tenant_id`, `metric_name`, `value`, `metadata`, `recorded_at`

## Notes & Feature Activation

- `notes`: `id`, `tenant_id`, `entity_type`, `entity_id`, `content`, `author_id`, `author_role`, `is_pinned`, `created_at`, `updated_at`
- `pack_activations`: `id`, `tenant_id`, `pack_id`, `status`, `activated_at`, `deactivated_at`

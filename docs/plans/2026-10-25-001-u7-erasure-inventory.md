# U7 erasure inventory: where one customer's personal data lives on `main`

**Created:** 2026-10-25
**Slice:** U7-00, Gate 0 of [`docs/plans/2026-10-18-002a-u7-data-subject-erasure-design.md`](2026-10-18-002a-u7-data-subject-erasure-design.md)
**Checked against:** `main` at `58383e730`
**Status:** for review on its own docs PR, before any erase code

## What this is

The U7 design says the erase starts with a written inventory of every place a customer's data can
live, reviewed before any erase code. This is that inventory. It lists every table, payload store,
external provider, log and backup that can hold one customer's personal data on `main`, how each is
linked to the customer, and what the erase does to it.

- **The subject** is one `customers` row. Whether a lead, or a phone number with no customer
  record, can also be erased is owner packet item 14
  ([`docs/plans/2026-10-25-002-u7-u8-owner-decision-packet.md`](2026-10-25-002-u7-u8-owner-decision-packet.md)).
- **How it was checked.** Every table and column comes from a scratch database built from `main`'s
  migration corpus (`compileMigrationSQL(MIGRATIONS)`), read back from `information_schema`. A
  table's number is the line of its `CREATE TABLE` in `packages/api/src/db/schema.ts`. A column's
  number is the line that defines it there, inside the `CREATE TABLE` or in the `ALTER TABLE … ADD
  COLUMN` that added it later. A provider entry cites its call site under `packages/api/src/`.
- **The corpus has 160 tables**, and three more are created outside it at runtime (see "Payload
  stores with no tenant column"). Every one of the 163 is listed below exactly once, either as a
  store, as checked with no subject data, or as outside this unit's subject.
- **Erase actions** follow the design's Scrub, Anonymize and Keep lists and its manifest rules. A
  store the design doesn't name has its action marked *proposed*, for review. The erase-coverage
  manifest and its catalog test (slices U7-02 and U7-03) are the proof; this list is where they
  start.

### Erase actions

| Action | Meaning |
|---|---|
| delete | The row is deleted, children first. |
| blank | The row stays; the listed columns take their declared scrubbed values. |
| anonymize | A retained row (financial, scheduling history): the listed columns are blanked, the link is kept (`keep-link`) or nulled (`null-link`), amounts and statuses stay. |
| content match | Found by the value pass or the historical scan, not by a link. A corroborated row is blanked; any other match goes on the owner's candidate list. |
| keep, suppression | Kept by law, as a do-not-contact or consent record (owner packet item 18). |
| target | The row's provider ids become targets of an external step before any link is severed. |
| provider delete, anonymize or retained | What the external step does; `provider_retained` means the provider keeps a copy and the result says until when. |

The six link kinds are the design's: direct (`customer_id` foreign key), bare column (a
`…customer_id` column with no foreign key), session- or call-linked, polymorphic
(`entity_type` / `entity_id`), identifier-linked (phone, email or name only), and external sinks.

## Tables linked through the customer's own records

| Table | `schema.ts` | Link | Subject data (column and line) | Erase action |
|---|---|---|---|---|
| `customers` | 306 | the subject | `first_name` 309, `last_name` 310, `display_name` 311, `company_name` 312, `primary_phone` 313, `secondary_phone` 314, `email` 315, `communication_notes` 318, `phone_normalized` 1280, `date_of_birth` 2925 | blank; never deleted, since kept rows link to it |
| `customer_contacts` | 4652 | `customer_id` 4655 | `name` 4656, `phone` 4659, `email` 4660, `notes` 4662 | delete |
| `customer_custom_field_values` | 4734 | `customer_id` 4737 | `value` 4739 | delete |
| `customer_tags` | 4688 | `customer_id` 4691 | `tag` 4692 | delete |
| `customer_group_members` | 5766 | `customer_id` 5770 | membership only | delete |
| `customer_payment_methods` | 4442 | `customer_id` 4445 | `stripe_customer_id` 4446, `stripe_payment_method_id` 4447, `brand` 4448, `last4` 4449, `stripe_account_id` 4500 | target (Stripe Customer), then delete |
| `portal_sessions` | 1757 | bare `customer_id` 1760 | `token_hash` 1761, `contact_id` 6450 | delete |
| `service_locations` | 337 | `customer_id` 340 (`NOT NULL`) | `label` 341, `street1` 342, `street2` 343, `city` 344, `state` 345, `postal_code` 346, `country` 347, `latitude` 348, `longitude` 349, `access_notes` 350 | anonymize, keep-link |
| `jobs` | 367 | `customer_id` 370, `location_id` 371 (both `NOT NULL`) | `summary` 373, `problem_description` 374, `deposit_stripe_payment_link_url` 2164 | anonymize, keep-link; target the deposit link |
| `job_timeline_events` | 394 | `job_id` 397 | `description` 401, `metadata` 404 | blank |
| `job_photos` | 1726 | `job_id` 1729, `file_id` 1731 (`NOT NULL`) | `notes` 1733 | blank; its `files` row is blanked, not deleted, and the S3 object is deleted |
| `job_custom_field_values` | 5657 | `job_id` 5660 | `value` 5662 | delete |
| `job_form_submissions` | 5523 | `job_id` 5526 | `answers` 5530 | blank |
| `expenses` | 2606 | `job_id` 2609 | `description` 2610, `vendor` 2613 | anonymize (proposed) |
| `material_items` | 6672 | `job_id` 6675 | `description` 6676 | anonymize (proposed) |
| `time_entries` | 1868 | bare `job_id` 1872 | `notes` 1877 | blank (proposed) |
| `feedback_requests` | 1040 | `job_id` 1043 | `token` 1044 | delete (proposed) |
| `feedback_responses` | 1060 | `job_id` 1064 | `comment` 1066 | blank (proposed); the rating stays |
| `appointments` | 417 | `job_id` 420 | `notes` 427 | blank; the row stays, its id is a fence key |
| `appointment_calendar_events` | 2368 | `appointment_id` 2371 | `external_event_id` 2374, `external_calendar_id` 2375 | target (Google Calendar), then delete |
| `technician_location_pings` | 989 | `appointment_id` 993 | `lat` 994, `lng` 995 | delete |
| `delay_notice_state` | 5345 | `appointment_id` 5348 | `trigger_context` 5356, `provider_message_id` 5355 | delete; the message id is a target |
| `dispatch_analytics` | 2792 | `appointment_id` 2799 | `metadata` 2801 | blank (proposed) |
| `recurring_jobs` | 5560 | `customer_id` 5563 | `title` 5564, `rule` 5566, `notes` 5567 | delete (proposed), so no new job is made for the subject |
| `service_agreements` | 1335 | `customer_id` 1338, `location_id` 1339 | `name` 1340, `description` 1341 | anonymize, keep-link (proposed) |
| `service_credits` | 2753 | `customer_id` 2756, `review_id` 2758 | links only | anonymize, keep-link |
| `estimates` | 523 | `job_id` 526 | `customer_message` 536, `internal_notes` 537, `accepted_by_name` 1227, `accepted_by_ip` 1228, `accepted_user_agent` 1229, `accepted_signature_data` 1230, `rejected_reason` 1232 | anonymize, keep-link; amounts stay |
| `estimate_line_items` | 553 | `estimate_id` 556 | `description` 557, `group_label` 3208 | anonymize |
| `estimate_approvals` | 596 | `estimate_id` 599 | `approved_by` 601, `rejected_by` 603, `rejection_reason` 605, `metadata` 608 | blank |
| `estimate_provenance` | 574 | `estimate_id` 577 | `source_reference` 579, `metadata` 584 | blank |
| `invoices` | 620 | `job_id` 623 | `customer_message` 637, `stripe_payment_link_url` 1243 | anonymize, keep-link; target every minted link |
| `invoice_line_items` | 654 | `invoice_id` 657 | `description` 658 | anonymize |
| `invoice_schedules` | 3598 | `job_id` 3601 | `milestones` 3608 | blank its free-text labels (proposed) |
| `payments` | 675 | `invoice_id` 678 | `notes` 687, `reversal_reason` 3483 | anonymize, keep-link; `reference_number` 686 stays for reconciliation |
| `financing_applications` | 5681 | `customer_id` 5685, `invoice_id` 5684 | `external_id` 5688, `application_url` 5689, `status_reason` 5692 | anonymize; Wisetack is `provider_retained` |
| `drip_enrollments` | 8355 | `customer_id` 8359 | `exit_reason` 8363 | delete, which ends the campaign for the subject |
| `drip_step_events` | 8388 | `enrollment_id` 8391 | `reason` 8395 | delete, before its enrollment |
| `leads` (converted) | 1397 | bare `converted_customer_id` 1411; `customers.originating_lead_id` 1477 | `first_name` 1400, `last_name` 1401, `company_name` 1402, `primary_phone` 1403, `email` 1404, `source_detail` 1406, `notes` 1409, `lost_reason` 1412, `phone_normalized` 1444, `attribution` 1469, `street1` 6202, `street2` 6203, `city` 6204, `state` 6205, `postal_code` 6206, `country` 6207, `access_notes` 6208 | blank, null-link; its own id goes into the tombstone |
| `lsa_leads` | 8538 | `lead_id` 8542 | `external_lead_id` 8541 | keep the ids; Google keeps the lead (`provider_retained`) |

## Tables linked through a call, session or conversation

| Table | `schema.ts` | Link | Subject data (column and line) | Erase action |
|---|---|---|---|---|
| `voice_sessions` | 1796 | `customer_id` 1799, `call_sid` 2486, `external_id` 1801 | `context` 1803, `transcript` 2517, `ended_reason` 1809 | blank, null-link; the call is a Twilio target |
| `voice_recordings` | 150 | `call_sid` 1326, `conversation_id` 154, `file_id` 153 | `transcript` 156, `transcript_metadata` 157, `answer` 6388; `recording_url` 1329 | blank; the audio is deleted in S3 and at Twilio; `recording_url` stays, it is an idempotency key; a row on legal hold waits (owner packet item 13) |
| `call_transcript_turns` | 1519 | `call_sid` 6952, `session_id` 6953, `voice_recording_id` 1522 | `text` 1525 | delete |
| `call_summaries` | 1304 | `call_id` 1307 | `summary` 1308 | delete |
| `call_me_back_tasks` | 3887 | `session_id` 3890, `call_sid` 3891 | `caller_phone` 3892, `caller_name` 3893, `callback_message` 3894, `intent_summary` 3895 | blank |
| `call_usage_events` | 7057 | `call_id` 7060 | `caller_phone` 7061 | anonymize (the billing ledger) |
| `lookup_events` | 1607 | `session_id` 1610, bare `customer_id` 1611 | `summary` 1615 | blank, null-link |
| `triage_events` | 4167 | `voice_session_id` 4170, bare `customer_id` 4171 | `signals` 4174 | blank (proposed) |
| `vulnerability_signals` | 2959 | `voice_session_id` 2962, bare `customer_id` 2963 | `signals` 2968 | blank (proposed) |
| `dropped_call_recoveries` | 2894 | `voice_session_id` 2897 | `caller_e164` 2898, `sms_message_sid` 2902, `context` 4294 | blank; the SMS is a Twilio target |
| `voice_call_scores` | 8414 | `session_id` 8417 | `items` 8421, `flags` 8422, `summary` 8423 | blank (proposed) |
| `voice_session_grades` | 7542 | `session_id` 7545 | `criteria` 7548 | blank (proposed) |
| `voice_call_corrections` | 8446 | `session_id` 8449 | `note` 8455 | blank (proposed) |
| `consent_events` | 4240 | bare `customer_id` 4243, `voice_session_id` 4248 | `phone_normalized` 4244 | keep, suppression |
| `conversations` | 108 | `entity_type` 112, `entity_id` 113 (the phone itself for an unmatched texter) | `title` 111 | blank; a phone-keyed row is a content match |
| `messages` | 128 | `conversation_id` 131, `file_id` 136 | `content` 133, `metadata` 138 | blank; attached files deleted |
| `conversation_links` | 5911 | `conversation_id` 5914, `entity_id` 5917 | links only | delete with the conversation's links |
| `proposal_sms_events` | 3966 | `message_sid` 3975 | `body` 3976, `from_phone` 3998 | blank (proposed); the message is a Twilio target |

## Polymorphic and AI-content tables

| Table | `schema.ts` | Link | Subject data (column and line) | Erase action |
|---|---|---|---|---|
| `audit_events` | 61 | `entity_id` 68, `correlation_id` 69, `actor_id` 64 | `metadata` 70 | anonymize by `(event_type, key)` pair, plus the value pass; DNC rows keep their phone |
| `files` | 85 | `entity_type` 93, `entity_id` 94 | `filename` 88, `s3_key` 92, `thumbnail_s3_key` 4072, `content_hash` 4074 | delete, or blank where a kept row's `NOT NULL` foreign key points at it; the S3 objects are deleted through cleanup rows |
| `attachments` | 4035 | `entity_type` 4039, `entity_id` 4040, `file_id` 4038 | `caption` 4042 | delete, or blank where kept (proposed) |
| `notes` | 929 | `entity_type` 932, `entity_id` 933 | `content` 934 | delete |
| `message_dispatches` | 1095 | `entity_id` 1099, bare `customer_id` 8185, `job_id` 8186 | `recipient` 1101, `provider_message_id` 1103, `error_message` 1105, `block_reason` 8189 | anonymize: `recipient` blanked, provider ids become targets first, errors kept as codes |
| `accounting_sync_log` | 4341 | `entity_type` 4345, `entity_id` 4346 | `external_id` 4347, `error_message` 4351 | target (QuickBooks), with the realm; the error becomes a code |
| `tenant_entity_aliases` | 6412 | `entity_kind` 6415, `entity_id` 6416 | `normalized_alias` 6417, `source_alias` 6418 | delete (a blank would fail its `CHECK` and unique index) |
| `proposals` | 708 | `target_entity_type` 716, `target_entity_id` 717, `conversation_id` 719, `ai_run_id` 718 | `payload` 714, `rejection_reason` 724, `execution_error` 725, `summary` 970, `explanation` 971, `source_context` 973, `rejection_details` 976, `original_payload` 6849 | anonymize (proposed; the design doesn't name it): free-text fields blanked per proposal type, type, status and ids kept as the approval record |
| `proposal_executions` | 1541 | `proposal_id` 1544 | `executed_payload` 1545, `error_message` 1549 | as `proposals` (proposed) |
| `proposal_analytics` | 743 | `proposal_id` 746 | `edited_fields` 749, `rejection_reason` 750 | blank (proposed) |
| `corrections` | 5209 | `proposal_id` 5212 | `before_value` 5215, `after_value` 5216 | blank (proposed) |
| `correction_lessons` | 4615 | `source_proposal_id` 4622 | `summary` 4624, `payload` 4625 | delete the lessons that reference the subject |
| `evaluation_snapshots` | 765 | `proposal_id` 768, `ai_run_id` 769 | `input` 771, `output` 772, `outcome` 773 | blank (proposed) |
| `supervisor_reviews` | 6069 | `proposal_id` 6072, `ai_run_id` 6073 | `checks` 6077, `flags` 6078 | blank free text (proposed) |
| `document_revisions` | 219 | `document_id` 223, `ai_run_id` 229 | `snapshot` 225, `metadata` 230 | blank (proposed) |
| `diff_analyses` | 242 | `document_id` 246 | `diff` 249, `summary` 250 | blank (proposed) |
| `ai_runs` | 175 | `correlation_id` 189 | `input_snapshot` 181, `output_snapshot` 182, `error_message` 184 | blank to U4's kept-keys shape and stamp `content_purged_at`; linked rows by correlation, older rows by content match; rows already purged are skipped; each becomes a Langfuse target |
| `shadow_comparisons` | 8938 | `ai_run_id` 8941 | `primary_response_text` 8946, `shadow_response_text` 8947 | blank, by `ai_run_id` with the subject's runs |
| `retrieval_eval_runs` | 1577 | `ai_run_id` 1580 | `query_text` 1581 | blank (proposed) |
| `knowledge_chunks` | 1654 | `source_type` 1658, `source_id` 1659 | `content` 1661, `content_scrubbed` 1662, `embedding` 1663, `metadata` 1666 | delete by source |
| `llm_cache` | 788 | `cache_key` 790 | `response` 793 | delete the tenant's entries for customer-content task types (proposed); entries also expire by `ttl_ms` |

## Tables matched by content or by identifier only

These hold the subject's name, phone, email or address with no link to the `customers` row.

| Table | `schema.ts` | Subject data (column and line) | Erase action |
|---|---|---|---|
| `leads` (not converted) | 1397 | as for converted leads above | the identifier-linked lead step: blank, and record the lead as a source in the tombstone |
| `tenant_dnc_list` | 1263 | `phone` 1266 | keep, suppression |
| `sms_recipient_sends` | 7355 | `phone` 7358 | delete the subject's rows (proposed) |
| `phone_rate_limits` | 2870 | `key` 2873 (the caller's number) | delete the subject's rows (proposed) |
| `maintenance_contracts` | 5074 | `customer_display_name` 5080, `location_street1` 5081, `default_summary` 5087 | content match (proposed) |
| `google_reviews` | 2683 | `external_review_id` 2686, `reviewer_display_name` 2688, `reviewer_profile_url` 2689, `comment_text` 2691; linked through `service_credits.review_id` when a credit exists | blank our stored copy; the public reply is owner packet item 19 |
| `daily_digests` | 4088 | `payload` 4092, `narrative` 4093 | content match (proposed) |
| `digest_entries` | 4471 | `rendered_text` 4478, `source_data` 4479, `owner_reply` 4481 | content match (proposed) |
| `standing_instructions` | 5804 | `instruction` 5807 | content match (proposed) |
| `vertical_training_assets` | 2563 | `raw_text` 2583, `scrubbed_text` 2584 (redacted on write, `verticals/training-asset-service.ts:481`) | content match (proposed); confirm the redaction leaves none |
| `privacy_audit` | 2542 | `redactions` 2550 (the training-asset redaction log) | content match (proposed); confirm it stores spans, not values |

## Payload stores with no tenant column

| Store | Where | Subject data | Erase action |
|---|---|---|---|
| `webhook_events` | `schema.ts:264`; `payload` 269, `error_message` 271 | Twilio bodies (`webhooks/routes.ts:3290`), SendGrid batches (`:3483`), Stripe `event.data` for every event type (`:1392-1398`), Vapi `{ tenantId, fromE164 }` (`integrations/vapi/webhook.ts:184-189`), Clerk payloads (`webhooks/routes.ts:760-766`, staff data). Voicemail and LSA receipts already hold ids only (`telephony/voicemail-status-route.ts:387-392`, `lsa/lsa-webhook.ts:134-137`). | writers keep only the keys their readers use, with a one-time backfill (slice U7-05+); the erase blanks SID-keyed rows; a purge blanks the rest after a window (owner packet item 17) |
| `_queue_messages` | `queues/pg-queue.ts:38`, `last_error` added at `:69` | payloads such as a delay notice (`DelayNoticeQueuePayload`, `notifications/delay-notifications.ts:262-277`), an emergency page's `callerPhone` (`telephony/emergency-page-retry.ts:66`) and MMS ingest's `fromPhone` and `body` (`sms/tech-status/mms-ingest.ts:323-332`) | an erase step by the payload's tenant and keys; moves into `MIGRATIONS` (slice U7-01) |
| `_queue_dlq` | `queues/pg-queue.ts:51` | the same payloads, plus handler error text | the same step, plus an age-bounded purge (owner packet item 17) with errors stored as codes |
| `_feature_flags` | `flags/pg-feature-flags.ts:27` | none | moves into `MIGRATIONS`; no erase step |
| `idempotency_keys` | `schema.ts:7434`; `response_body` 7441 | cached API responses, such as a customer create, for 24 hours | a step waits out the lifetime plus the prune interval |

## External providers

| Provider | What it receives, and where | Erase action |
|---|---|---|
| Twilio Messages, with MMS Media | outbound SMS through `GatedMessageDelivery` (`app.ts:1698`) → `PerTenantTwilioDeliveryProvider` (`notifications/per-tenant-twilio-delivery-provider.ts:58`) → `notifications/twilio-delivery-provider.ts:228`, `Messages.json` at `:265-266`; inbound captures store the SID with the customer (`sms/inbound-capture.ts:293-309`) | delete each linked Message and its Media on its own account; Twilio keeps bodies in backups for 30 days (`provider_retained`) |
| Twilio Calls | outbound `Calls.json` (`telephony/outbound-call-service.ts:250-266`); inbound calls to tenant numbers; `<Dial>` child legs | delete each completed linked Call, children first through `ParentCallSid` |
| Twilio Recordings | recording and voicemail callbacks fetch and store the audio (`telephony/recording-webhook.ts:391-407`, `telephony/voicemail-status-route.ts:533-556`); U4's deleter maps any 404 to `already_gone` on platform credentials (`telephony/twilio-recording-deleter.ts:87-104`) | delete per account, with tenant credentials (slice U7-37) |
| Twilio speech recognition and voices | `<Gather input="speech">` and `<Say>` in TwiML (`telephony/twilio-adapter.ts:758`, `routes/telephony.ts:1471`) | part of the Call's log; deleted with the Call |
| Stripe | the saved-card Customer with name, email and internal id (`payments/stripe-saved-card.ts:84-124`); Payment Link products named `Invoice <n> — <display name>` (`invoices/public-invoice-service.ts:354`, `:387`; `estimates/public-estimate-service.ts:889-891`, `:914`) | delete the Customer on its account; rename every minted Product; Checkout line items and charges are `provider_retained` |
| QuickBooks | the customer (`integrations/accounting/sync-service.ts:280-310`, `integrations/accounting/quickbooks-client.ts:93-103`); SalesReceipt lines with each line description (`integrations/accounting/quickbooks-client.ts:122-145`) | anonymize the customer and rewrite the receipts, realm-guarded (owner packet item 20); the company Audit Log is `provider_retained` |
| Google Calendar | events with the customer's name and address (`integrations/calendar-sync.ts:132-179`), stamped with `serviceos_appointment_id` | delete every match of the stamp, on the recorded account; the calendar bin keeps them about 30 days |
| Wisetack | name, email and phone on the financing application (`financing/financing.ts:133-145`) | `provider_retained`, linked by its webhook |
| S3 or R2 storage | uploads, recordings, photos, MMS and thumbnails (`files/storage-provider.ts:214-231` for signed uploads, `:269` for `putObject`; keys at `files/file-service.ts:194`, `routes/attachments.ts:136`, `telephony/recording-webhook.ts:113-119`, `workers/image-post-process-worker.ts:60-62`) | delete every version and replica, then a backstop listing with no end date; object-created notifications need a queue and credentials (an owner action) |
| CDN | permanent public URLs when `STORAGE_PUBLIC_URL` is set (`files/storage-provider.ts:233-236`) | purge each deleted key, confirmed by the CDN (purge credentials are an owner action) |
| Langfuse | gateway inputs and outputs while `LANGFUSE_CAPTURE_CONTENT` is on (`ai/gateway/trace-exporter.ts:104-129`) | delete per project, wait, re-check; project retention is an owner action |
| Vapi | whole calls by number routing (`integrations/vapi/client.ts:96-104`, `workers/provision-twilio.ts:602-650`), with the caller's number, transcript and recording | delete each call through the API, or a recording-off boot guard (owner packet item 9) |
| ElevenLabs | the text it speaks (`ai/tts/elevenlabs-stream.ts:119-121`, sent at `:201`; buffered at `ai/tts/tts-provider.ts:203`) | Zero Retention Mode, or a history-deletion step (owner packet item 10) |
| Deepgram | live call audio (`voice/transcription-providers.ts:582`, sent at `:745`); browser dictation on a 30-second grant (`voice/deepgram-token.ts:15-18`) | `provider_retained`; `mip_opt_out` on every request (owner packet item 11) |
| OpenAI | chat and embeddings (`ai/providers/openai-compatible.ts`), Whisper (`voice/voice-service.ts:329`, `voice/transcription-providers.ts:254`), speech (`ai/tts/tts-provider.ts:144`) | `provider_retained` for up to 30 days unless zero data retention applies (owner packet item 12) |
| OpenRouter | the same requests when it is the configured endpoint (`ai/gateway/factory.ts:36-57`; `.env.production.example:105` makes it the primary) | `provider_retained`, keyed by the endpoint host; it forwards to upstream providers |
| Anthropic | Layer 2 requests to its OpenAI-compatible endpoint (`ai/gateway/layer-two-models.ts:12`) | `provider_retained`, under its own endpoint-host entry |
| SendGrid and Twilio Email | the recipient and body (`notifications/twilio-delivery-provider.ts:361-380`, `notifications/twilio-email-delivery-provider.ts:215-231`) | activity is `provider_retained`; bounces, blocks and invalid emails are deleted from the suppression lists; spam reports and unsubscribes stay |
| Google Maps | service addresses for geocoding (`locations/geocoder.ts:80`) and travel time (`scheduling/travel-time/google-provider.ts:83`) | `provider_retained`; no per-request delete |
| Google Business Profile | our public reply to a review (`reputation/google-business-client.ts:412`) | owner packet item 19 |
| Google Local Services Ads | the leads it sends us (`lsa/lsa-webhook.ts`) | `provider_retained` |
| Sentry | errors, redacted in `beforeSend` (`monitoring/sentry.ts:77`) | `provider_retained` under its retention; check the redaction covers phones and emails |
| PostHog | product events built from audit events (`analytics/posthog.ts:120`; `analytics/audit-event-mapping.ts` keeps them to ids and enums) | `provider_retained`; check that no event carries a subject value |
| Pendo (web) | staff sessions in the browser (`packages/web/src/main.tsx:39-40`, `packages/web/src/components/auth/AnalyticsIdentityBridge.tsx:66`) | not the subject's data unless page text is captured; check Pendo's capture setting |
| Cloudflare Turnstile | a webchat visitor's challenge token (`webchat/webchat-guard.ts:46`) | none expected; check |
| Clerk | staff accounts only | outside this unit's subject |

## Logs and backups

| Store | Where | Erase action |
|---|---|---|
| Application logs | JSON to stdout (`logging/logger.ts:32`), with secret redaction only; the hosting provider keeps them | `provider_retained` under the hosting provider's log retention; no per-entry delete |
| Postgres backups | the managed database's backups | `provider_retained` until their retention dates; a restore needs the runbook's re-erase step (design, "Backups keep what the erase removes") |
| Bucket versions and backups | the storage provider | covered by the S3 step's version-aware deletes; backups are `provider_retained` |
| Provider-side copies | Twilio backups (30 days), the QuickBooks Audit Log, the Google Calendar bin, Stripe charge records | `provider_retained`, listed in the result with each provider's period |

## Checked, with no subject data

`appointment_assignments` (504), `recurring_job_occurrences` (5608), `batch_invoice_runs` (3630),
`invoice_dunning_events` (3541), `invoice_dunning_configs` (3517), `payment_refunds` (6513),
`service_agreement_runs` (1364, its `error_message` becomes a code), `ai_voice_usage_costs` (6987),
`ai_voice_cost_reconciliation` (7008), `ai_voice_usage_settlements` (7033),
`call_usage_settlements` (7080), `voice_approval_pin_lock_alerts` (6972), `send_claims` (6354, its
`claim_key` is built from ids; U7-03 confirms), `weather_cache` (2939, rounded coordinates and no
link), `catalog_items` (1015), `estimate_templates` (838), `service_bundles` (865),
`message_templates` (5237), `customer_text_wording` (8222), `marketing_campaigns` (5710),
`drip_sequences` (8336), `customer_groups` (5741), `customer_custom_field_defs` (4710),
`job_custom_field_defs` (5635), `job_form_templates` (5499), `wording_preferences` (888),
`brand_voice_versions` (6000), `supervisor_policies` (4203), `prompt_versions` (203),
`provider_health` (807), `quality_metrics` (911), `vertical_packs` (821), `pack_activations`
(951), `regional_price_tiers` (7669), `review_poll_state` (2727), `tenant_feature_flags` (4014),
`tenant_budget_counters` (4220), `usage_alerts` (7128), `hfcr_weekly_sends` (4370),
`lifecycle_emails` (5143), `notification_preferences` (5104), `oauth_states` (2335),
`device_tokens` (4946), `technician_working_hours` (3566), `tenant_oncall_rotation` (1288),
`tenant_provisioning_costs` (482), `tenant_integrations` (457), `accounting_integrations` (4318),
`lsa_integrations` (8513), `call_forwarding_checks` (8275, the tenant's own numbers),
`tenant_sites` (8305), `webchat_config` (8474), `webchat_usage_daily` (8494).

## Outside this unit's subject

Staff, tenant and prospect data, which the erase of a customer doesn't touch: `users` (41),
`tenants` (29), `tenant_settings` (282), `pending_invitations` (2200),
`user_calendar_integrations` (2287), `a2p_registrations` (7461), `onboarding_drafts` (7685),
`onboarding_session` (4918), `tech_status_today` (3014), `tech_unavailable_blocks` (2988),
`platform_deprovision_log` (3114), and the demo-call tables `demo_calls` (7806),
`demo_tenant_leases` (7775), `demo_handoff_outbox` (7868), `demo_inflight_jobs` (7841),
`demo_call_budget` (7857) and `signup_handoffs` (7883), whose visitor phones are stored hashed.

## What the review should settle

- **The proposed actions.** Every row marked *proposed* is a store the design doesn't name. The
  manifest needs a decision on each, with its reason.
- **Columns the design never named.** `customers.date_of_birth`, the estimate acceptance columns
  (`accepted_by_name`, `accepted_by_ip`, `accepted_user_agent`, `accepted_signature_data`) and
  `proposals` are listed here for the first time.
- **Free-text stores with no link.** Digests, standing instructions, maintenance contracts and
  training assets can name a customer in prose, and only names inside text that the content scan
  reads are found. The design accepts that the value pass matches phones and emails only.
- **Checks still to run** before U7-14b classifies them: Sentry's redaction, PostHog's event
  properties, Pendo's page-text capture, Turnstile, `send_claims` keys, and the training-asset
  redaction log.
- **Owner answers this list depends on:** items 9 to 14, 17 to 20 of the owner packet.

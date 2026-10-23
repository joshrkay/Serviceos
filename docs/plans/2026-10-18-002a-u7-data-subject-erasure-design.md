# U7 design: data-subject erasure (PRIV-5)

**Part of:** [`docs/plans/2026-10-18-002-fix-ai-enterprise-hardening-plan.md`](2026-10-18-002-fix-ai-enterprise-hardening-plan.md).
**Status:** draft design, pending the owner decision named below. The plan's Key Technical
Decisions (durable, resumable jobs; limits serialized with their consumers) and its owner
decisions apply here. U7 and U8 refer to each other by name; both live next to this file.

## U7. Data-subject erasure (PRIV-5) — after U4, needs an owner decision

- **Goal:** an owner can erase one customer's personal data and AI artifacts, short of purging the
  whole tenant.
- **Dependencies:** U4 (the Twilio deleter seam and the `ai_runs` purge), plus owner decision 1 below.
- **Design rules:** both rules under Key Technical Decisions apply. In this unit:
  - **Durable, resumable jobs:** the erasure job that runs phase 2, the out-of-database erase
    record, the S3 re-delete, the Langfuse second delete, each outbound send's write-ahead row,
    the owner's candidate confirmations, and the `erase_incomplete` alert.
  - **Limits serialized with their consumers:**
    - The tombstone and every fenced writer, under the erasure lock, which covers every key the
      tombstone holds. That includes a key phase 2 adds, such as a lead the lead step records or
      a key the inbox mover collects under a late link, each of which takes its stripe in
      exclusive mode like phase 1, and a released send, which passes the fence again before its
      flip.
    - The job's close and every late target that re-opens it, a re-armed target included, under
      the job row's lock. Every U7 transaction that touches a job row takes it first, and takes
      several job rows in ascending id order.
    - Each step's terminal transition, under that step's own generation.
    - The historical `ai_runs` scan reads no retention setting at all, so a window changed
      mid-erase can't narrow it.
- **Patterns to follow:**
  - `packages/api/src/integrations/twilio/a2p-10dlc/registration.ts:21-24` and
    `packages/api/src/workers/a2p-10dlc-registration.ts` (a provider workflow that checkpoints every
    created resource and resumes after a crash)
  - `packages/api/src/proposals/pg-proposal.ts:644-655` (a guarded claim) and `:657` (stale claims
    retried, then failed after a retry limit)
- **Approach**, recommended defaults pending that decision:
  - The endpoint is `POST /api/customers/:id/erase`:
    - owner-only and audited
    - an explicit human action, never an AI proposal
    - **Two phases, not one transaction.** The tombstone has to be visible to other processes
      before the scrub starts. `executeAudited` opens `BEGIN` and commits only after its whole state
      change and its audit insert, so a tombstone written inside the same transaction would stay
      invisible while in-flight writers pass their checks. The erase therefore runs in two phases:
      1. A short audited transaction commits the tombstone (and an `erase_started` audit event).
      2. A durable erasure job then runs the target snapshot, the scrub, the external cleanup, the
         drain and the final re-scan, each step in its own short audited transaction, and records
         `erase_completed` or `erase_incomplete`.
    - **Phase 2 is a durable, resumable job, not code that runs after the request.** A process can
      exit after phase 1 commits. The tombstone would then keep fencing the subject while nothing
      finished the erase, and the customer would stay partly erased indefinitely. So:
      - **One job row per erase, written by phase 1.** Phase 1 inserts a `customer_erasure_jobs` row
        in the same transaction as the tombstone and `erase_started`, so a tombstone never exists
        without a job. The table has `tenant_id` and RLS like every tenant table. It has a unique
        index on `(tenant_id, customer_id)`, so a second erase request returns the existing job
        instead of starting another.
      - **Every table U7 adds carries `tenant_id` and forced RLS, not only the job row.**
        `rls-force-catalog.test.ts` checks only tables that have a `tenant_id` column. A table
        keyed only by `job_id` would ship without RLS and still pass, and the status-callback and
        email-event handlers, which start with no tenant context, could then write against another
        tenant's job. So:
        - `customer_erasure_steps`, the tables that hold step targets and candidates,
          `customer_erasure_identifiers` (see "The raw identifiers outlive the `customers`
          scrub" below), `erasure_storage_cleanup`, the tombstone, the late-link inbox (see "A
          write that links new data to the erased subject" below), the start-failure counts
          (see "Repeated failures to start alert" below), and the fence's write-ahead claims if
          they get a table of their own, each have `tenant_id NOT NULL`, `ENABLE` and
          `FORCE ROW LEVEL SECURITY`, and the usual tenant policy.
        - Each child row references its job by `(tenant_id, job_id)` →
          `customer_erasure_jobs (tenant_id, id)`, so a row can't point at another tenant's job.
        - **The test derives that set from the catalog, not from a list of U7 tables.** A list
          would have to be kept by hand, and a later U7 table left off it would escape both tests.
          A fence claims table isn't reached through the job either. Claims exist before any
          erase, so a new sink's claims table, keyed by `customer_id` and `source_id`, has no
          foreign key to the job. If it also had no `tenant_id`, `rls-force-catalog.test.ts`
          would skip it, and a status-callback handler could write another tenant's claim. So
          each of these must have `tenant_id NOT NULL` and forced RLS:
          - every table with a foreign key to `customer_erasure_jobs`, and every table the
            manifest classifies as "the erasure record"
          - every claims table that an `externalSinks` entry names
          - every table that has a manifest entry
          The only exceptions are on a short explicit list of global tables, each with a reason,
          such as the capture-on intervals and `webhook_events`. A foreign key to
          `customer_erasure_jobs` must be the composite one above, and the test fails on any
          single-column foreign key to it.
        - **The global list is pinned and constrained, not a free allowlist.** A new sink's
          claims table could be created without `tenant_id`, because its webhook starts with no
          tenant context, and added to the list with the reason "written by a tenantless
          webhook". The test would pass, and the handler could write another tenant's claim. So:
          - The list sits in the same reviewed snapshot as the `exempt` ids (see "`exempt` is not
            a free-text allowlist" below).
          - It can't hold a table that has a foreign key to `customer_erasure_jobs`, that an
            `externalSinks` entry names, or that has a subject-key column (the names listed in
            "The catalog test also finds tables linked by the tombstone's other keys" below).
        - A handler that starts with no tenant context takes the tenant from the signed request.
          The per-send status-callback URL carries the tenant id beside the row id, and so does an
          email's custom metadata. The handler sets that tenant before it writes.
      - **The erase's own records are classified `keep`, and hold no subject data once done.** The
        job row's `customer_id` and the tombstone's customer id are `%customer_id` columns, so the
        coverage test forces a classification. As `scrub` or `anonymize` they would get the
        erasure trigger, and phase 1's own insert would be refused, because its tombstone is
        visible inside its own transaction. So:
        - Every table U7 adds is classified `keep`, with the reason "the erasure record", and has
          no erasure trigger.
        - An S3 key can name the subject. An attachment key ends in the uploaded filename
          (`routes/attachments.ts:136`, `${fileId}-${safeName}`). So each S3 target and cleanup
          row stores the bucket, the `files` id when there is one, and the key encrypted with
          `encrypt`. The key is nulled in the transaction that marks its target done. The S3 step
          also nulls the key on each subject write-ahead claim it took a target from.
        - A stored error keeps only the provider's error code and HTTP status, never its message
          text, which can echo the customer's name.
        - These tables are `keep`, but each of their columns is still classified (see "Coverage
          is per column" below). A later `last_error text` that stored a provider's message would
          fail the schema test.
      - **`audit_events` is classified `anonymize` by metadata key.** It is an `entity_type` /
        `entity_id` table (`schema.ts:61-72`), so the coverage test forces a class. Its `metadata`
        JSONB holds subject PII today: `workers/call-me-back-worker.ts:100` writes
        `{ callerPhone }`, with the session id as `correlation_id`. As `keep`, that phone would
        survive every erase. With the plain erasure trigger, phase 1's own `erase_started` event
        would be refused, and so would the audit insert of every audited write on a retained
        invoice, whose `entity_id` is a tombstone key. That rolls back the payment update the
        fence must let through. A trigger keyed on `entity_id` would also take a stripe for U8's
        spend events under the spend lock. So:
        - **The manifest classifies `(event_type, key)` pairs, not bare keys.** A bare key can mean
          two things. `jobs/job-money-state.ts:139` writes `{ from, to }` holding money states on
          a job, and `routes/onboarding.ts:955` writes `{ from, to }` holding phone numbers. A
          list of bare safe keys would have to hold `from` and `to`, so a later
          `customer.phone_changed { from, to }` would keep both phones through the erase. `error`
          and `name` are ambiguous the same way. So each pair is listed as PII or safe
          (`callerPhone`, `callerName`, `recipient`, `email`, `phone` and so on, per event type).
          `createAuditEvent` checks each pair against the two lists, and under test it throws on a
          pair in neither. A new event type therefore needs its own entries, even for a key that
          is already listed.
        - **The lists are enforced at build time, and the backstop doesn't depend on them.** A
          throw under test catches only a path some test runs. A later route could write
          `customer.contact_merged { mergedPhone }` through `createAuditEventBestEffort`
          (`audit/audit.ts:95`) with no test on that call. In production the pair is in neither
          list, so the trigger, the strip and the value pass would all treat it as safe, and the
          phone would survive every erase.
          - **A check at the `createAuditEvent` call can't see most audit writes.** The inner
            call is generic almost everywhere. `executeAudited` runs `createAuditEvent(input)`
            on whatever the caller's `audit` callback returns
            (`commands/command-runner.ts:92-101`). `createAuditEventBestEffort` passes its own
            parameter through (`audit/audit.ts:95-100`). About 30 local helpers take
            `eventType: string` and `metadata: Record<string, unknown>`, such as
            `sms/tech-status/handler.ts:75-92` (which adds `fromE164`),
            `invoices/invoice-payment-link.ts:300` and `materials/job-materials.ts:55`.
            Onboarding builds `agent.onboarding.${eventType}` into `SideEffect` objects
            (`ai/agents/onboarding/transitions.ts:86`), which
            `ai/orchestration/onboarding-conversation.ts:370` turns into audit events. Two
            paths insert into `audit_events` with raw SQL (`demo/platform-audit.ts:34`,
            `learning/entity-aliases/pg-entity-alias.ts:93`). A check at the call would fail
            on all of these, an implementer would have to exempt the wrappers, and those are
            exactly the paths left unchecked. A `{ fromName }` added through the tech-status
            helper would then keep the subject's name through every erase, since that row's
            `entity_id` is a message SID that no tombstone key selects. So:
          - The classification is a compile-time type. The manifest generates an
            `AuditEventInput` union keyed by literal `eventType`. Each member has an exact
            `metadata` type, with no index signature and nested objects typed down to their
            leaves. The compiler then checks every object that becomes an audit event, wherever
            it is built: an `executeAudited` callback, a best-effort call, a `SideEffect` or a
            helper.
          - Helpers become generic, `<E extends AuditEventType>(eventType: E, metadata:
            AuditMetadata<E>)`, and so does the audit variant of `SideEffect`.
          - A structural test fails on a cast to `AuditEventInput` or `AuditMetadata`, on an
            `any`- or `string`-typed value where an `eventType` goes, and on SQL that inserts
            into `audit_events` outside `audit/pg-audit.ts`. The two raw inserts above move
            onto the repository.
          - Fixture: a helper typed `(eventType: string, metadata: Record<string, unknown>)`
            that feeds `createAuditEvent` fails to compile.
          - The strip, run on rows keyed by a tombstone key, treats any pair in neither list as
            PII.
          - The trigger's PII pair list is generated from the manifest, and the schema test
            compares the trigger's list with the manifest's.
        - An `error` value is stored as a code, never as `err.message`.
        - **A phase-2 step strips PII by link and by value.** Picking rows only by `entity_id` or
          `correlation_id` misses a row keyed by something else. `sms/tech-status/handler.ts:83-91`
          writes `fromE164`, and its `entity_id` falls back to the message SID when the sender
          isn't a technician. A customer whose text is routed there leaves their phone in a
          `tech_status.unverified_mobile` row that no tombstone key selects. So the step:
          - strips the PII pairs from every audit row whose `entity_id` or `correlation_id` is a
            tombstone key
          - also normalizes and keyed-hashes every string leaf of `metadata` in the tenant's
            audit rows, not only PII-classified values, in a batched scan, and compares it with
            the subject's phone and email hashes. A
            match is scrubbed or candidate-listed by the same corroborated-or-candidate rule as
            the historical `ai_runs` scan, since a household can share a phone.
          The row, its ids and its other keys stay. The final re-scan repeats the value pass.
        - The `audit_events` trigger refuses only a write that sets a PII pair on a row whose
          `entity_id` or `correlation_id` is a tombstone key. It takes a stripe only for a row
          that sets one. `erase_*`, financial and spend events set none, so they pass without a
          stripe.
        - A DNC audit row (`routes/dnc.ts:92`) follows the DNC rows' rule, as a suppression
          record.
        - Test: erase a customer who has a call-me-back audit row. Its `callerPhone` is gone,
          `erase_started` commits, and a later payment on the retained invoice commits with its
          audit event. The seed also holds a message-SID-keyed `tech_status.unverified_mobile` row
          with the subject's phone, and a `{ from, to }` phone-change row on the customer. The
          phone-change row is stripped, and the tech-status row is candidate-listed. Once the
          owner confirms it, no `audit_events` row other than a DNC suppression record holds the
          subject's name, phone or email.
      - **Every target the later steps need is recorded before any step destroys the links to
        it.** A step takes its targets from its own row, never by re-walking links. A crash after
        the scrub has nulled a nullable link, such as `leads.converted_customer_id`, or blanked
        `stripe_customer_id`, would otherwise leave the resumed step with nothing to find. The
        work is split so phase 1 stays short:
        - Phase 1 writes one `customer_erasure_steps` row per store, unique on `(tenant_id,
          job_id, step)`. A store the manifest adds later gets its row on first use (see "Every
          late-target path first makes sure its step row exists" below). Phase 1 writes no
          per-row targets. Their number grows with the customer's history, and phase 1 runs
          under a sub-second deadline (see "Phase 1 is sized by its fence keys" below).
        - The job's first step is `erase_record` (see "Backups keep what the erase removes"
          below). The next, `snapshot`, records every target in batched checkpoints: each local
          row of the closure as a target of its store's step, and the external ids, which are
          the Stripe Customer id, the QuickBooks customer id, the Twilio Call, Message and
          Recording SIDs, the S3 keys, the calendar event ids and the Langfuse trace keys.
        - No step that severs a link or blanks a column starts until `snapshot` is `done`, so every
          link `snapshot` reads is still there.
        - Target rows are unique on `(tenant_id, job_id, step, target_id)`. `snapshot` inserts
          with `ON CONFLICT DO NOTHING`, so it is safe to repeat. A late target is different: it
          may meet a target that is already done, and re-arms it (see "A target that comes back
          re-arms its row" below).
        - **The `target_id` carries the provider's scope, not only its id.** Many provider ids
          are unique only inside a scope. QuickBooks Ids are per company and per entity kind, so
          Jane's Customer can be Id "58" while one of her synced invoices is SalesReceipt "58"
          in the same realm. Both are targets of the one QuickBooks step. With a bare id, the
          receipt would hit the customer's row, `DO NOTHING` would drop it, and its line
          descriptions would stay while the store reports done. A late "58" from another realm
          would instead re-arm the first realm's row, and the realm guard would send it to
          `provider_retained`. So:
          - QuickBooks: `<realm>:<entity kind>:<Id>`.
          - Google Calendar: `<Google account>:<calendar id>:<event id>`, since event ids are
            unique per calendar.
          - Langfuse: `<project>:<trace id>`, since trace ids are unique per project and a
            session can span projects across a config move.
          - S3: a keyed hash of the bucket and key, which stays after the key is nulled.
          - Twilio and Stripe ids are globally unique and stay bare. The row still records the
            account (see "Every external target records the account it lives on" below).
          - The idempotency key and the QuickBooks `requestid` derive from the full
            `target_id`. The re-arm upsert never changes a target's account columns.
          - The seed-and-erase test adds a QuickBooks customer and a SalesReceipt with the same
            Id, and requires both to be anonymized.
        - A late target that arrives before `snapshot` runs is added to its step row like any
          other.
      - **A late target re-opens the job under the job row's lock, so a close can't miss it.** A
        target found later is added to its step in the transaction that finds it. Examples: a SID
        linked by the status callback, a key from a late upload, a recording a fenced webhook
        registers, the owner's confirmation of a candidate. Touching the job row only "if it had
        closed" isn't enough. Under `READ COMMITTED` the worker closing the job and the handler
        adding the target each miss the other's uncommitted write. The job can then close
        `completed` while one of its steps is pending again, and a sweep that claims only
        non-terminal jobs never runs that step. So:
        - Every target add, candidate confirmation and re-open also runs one unconditional
          `UPDATE` on the job row in its transaction. It sets `generation = generation + 1`. When
          the job was terminal, it also puts `state` back to `pending` and stamps `opened_at` and
          `opened_generation` (see "A job-age alarm" below). That takes the job row's lock. The
          step re-open below sets that step's own `next_attempt_at` to now (see "`next_attempt_at`
          is per step" below). It never moves a time gate (see "A time gate is its own column"
          below).
        - **The database enforces the re-open, so no source can skip it.** Targets arrive from at
          least seven places, each written separately: the SMS and call status callbacks, the
          email event handler, the Vapi webhook, the S3 object-created worker, the backstop
          listings, the refusal registration of a sink whose provider copy comes first (see "A
          refusal still registers the external copies" below), and the owner's candidate
          confirmation. One that inserts its
          target but skips the job-row `UPDATE` would leave a `completed` job that the sweep never
          claims again, and the job-age alarm watches only open jobs. So triggers on each
          step-target table run that job-row `UPDATE`, and the step re-open below, in the writing
          transaction. These are U7's own `keep` tables, so they don't meet the erasure trigger. A
          candidate confirmation adds its rows as targets, so it fires them too. The daily retry
          and the repeat `POST` add no target, and run the same re-open directly.
        - **The re-open triggers are statement-level, so a batch touches the job row once.** A
          row trigger would run one job-row `UPDATE` and one step-row `UPDATE` per target, and a
          `snapshot` batch of thousands of targets would rewrite the same two rows thousands of
          times in one transaction. So each step-target table has statement-level `AFTER
          INSERT` and `AFTER UPDATE` triggers with transition tables. The function reads the
          inserted rows, or the old and new rows of an update, keeps those that became
          `pending`, and runs one job-row `UPDATE` and one step-row `UPDATE` per (job, step)
          among them: jobs in ascending id order, each job before its steps.
        - **Every late-target path first makes sure its step row exists.** The tombstone is never
          lifted, so a job outlives changes to the manifest, and phase 1 created step rows only
          for the stores that existed then. Say a later release adds an `anonymize` table linked
          by `payment_id`, and months after a job completed, a row for the erased customer's
          retained payment is inserted. Its target insert would fail the foreign key to
          `customer_erasure_steps` with `23503` on every mover pass, every minute. The job stays
          `completed`, the age alarm watches only open jobs, and nothing would alert. So:
          - Every path that adds a target (the inbox mover, the status-callback, email-event and
            Vapi handlers, the S3 object-created worker, the backstop listings, refusal
            registration and owner confirmation) first runs `INSERT INTO customer_erasure_steps
            (…) VALUES (…) ON CONFLICT (tenant_id, job_id, step) DO NOTHING` under the job-row
            lock. The target insert, and the re-open its trigger runs, then find the row.
          - **A step re-open always matches its row, and raises only when the row is missing.**
            It never passes silently. A re-open written as an `UPDATE ... WHERE state <>
            'inputs_expired'` would match no row for an `inputs_expired` step and raise on every
            mover pass (see "The step re-open and `inputs_expired`" below).
          - A confirmation adds its targets to one confirmation step per candidate kind, created
            on first use by the same upsert. A step row per confirmation would fail with `23505`
            on the second confirmation of a kind, so that candidate could never be scrubbed.
          - An inbox row still unmoved past a fixed age marks an operator alert due on its job,
            in a slot of its own. In one transaction, job row first, the sweep sets the inbox
            row's `alert_marked`, guarded on it being false, and bumps the job's
            `inbox_alert_due_generation`. That transaction is its own, never a mover's, so a
            mover that keeps failing can't roll the marking back. It sends and stamps
            `inbox_alert_sent_generation` like the close's alert.
          - Test: a job created under an older manifest receives a late link for a newly added
            table, and processes it. A second confirmation of the same candidate kind is
            processed too.
        - **A target that comes back re-arms its row, and the re-arm re-opens the job too.** A
          Langfuse trace that reappears has the trace id of its `done` target, and a late S3
          object has the key hash of its closed one. An `INSERT ... ON CONFLICT DO NOTHING`
          inserts no row, so the re-open trigger finds nothing to re-open, and a plain `INSERT`
          fails with `23505` on every pass. Either way the job stays `completed` and the object stays.
          So:
          - A late-target add is an upsert: `INSERT ... ON CONFLICT (tenant_id, job_id, step,
            target_id) DO UPDATE SET state = 'pending', attempts = 0, rearm_count =
            rearm_count + 1, <encrypted payload> = EXCLUDED.<encrypted payload>`, with a `WHERE`
            that skips a target already `pending`. It stores the encrypted payload again, such
            as the S3 key, and never changes the target's account columns. A target a worker
            has in progress is re-armed too. The worker's checkpoint that marks a target done is
            guarded on its state still being the in-progress state the worker set, so after a
            re-arm it matches no row, and the worker runs that target again.
          - `ON CONFLICT DO UPDATE` writes a re-armed row as an update, so the `AFTER UPDATE`
            statement trigger above sees it in its transition tables, and the `AFTER INSERT` one
            sees only rows actually inserted. A plain `UPDATE` that re-arms a target fires the
            `AFTER UPDATE` trigger too. Postgres doesn't allow transition tables on an `UPDATE
            OF state` trigger, so the function pairs old and new rows by primary key itself.
          - **A worker's own retry never moves a target back to `pending`.** If it did, the
            trigger would re-open the step on every retry and reset its `attempts`, so the step
            would never reach its retry limit or end `incomplete`. So a `BEFORE UPDATE` row
            trigger on each step-target table raises on a move from any other state to `pending`
            that doesn't also raise `rearm_count`. Only the re-arm path raises it.
          - The catalog test requires the two re-open triggers and the re-arm guard on every
            table with a foreign key to `customer_erasure_steps`, so a step-target table that a
            later sink adds carries them.
          - **Every table whose rows a step processes has that foreign key.** A rule keyed only
            on the steps table misses `erasure_storage_cleanup`, whose rows carried only the job
            id. Its rows are inserted with the `files` delete, and nothing orders that delete
            before the S3 step's `done`. A delete that retries after backoff, once the S3 step
            has checkpointed `done`, would insert cleanup rows that fire no trigger. The job
            would close `completed`, and the backstop listing, which runs only after a row
            closes, would never run for them. So:
            - `erasure_storage_cleanup`, and every later per-job work table, carries `step` and
              a composite foreign key `(tenant_id, job_id, step)` → `customer_erasure_steps`.
            - The catalog test fails on a table with a composite foreign key to
              `customer_erasure_jobs` and none to `customer_erasure_steps`, unless it is on an
              explicit exception list with a reason: the steps table itself, the tombstone, the
              late-link inbox, the candidates table and `customer_erasure_identifiers`.
            - It also asserts that each re-open trigger's `tgfoid` is the re-open function.
            - **It checks the re-open by behavior too.** Trigger metadata can be right while a
              copied definition is wrong. A later work table whose rows start in a state such
              as `waiting` until `not_before`, given triggers that act only on `pending`, would
              never re-open a `completed` job. So for every table with a foreign key to
              `customer_erasure_steps`, the Docker-gated catalog test inserts a target in each
              non-terminal initial state its state `CHECK` allows, and re-arms a done one,
              against a `completed` job. Each must re-open the job and the step. The test also
              compares `tgqual` and `tgattr` with the generated definition.
            - Test: a cleanup row inserted after the S3 step is `done` re-opens the step and
              the job. A failing target's retry leaves the step's `attempts` counting up, and a
              move back to `pending` without a re-arm raises.
          - Tests: a `done` target in a `completed` job is re-armed once by a plain `UPDATE` and
            once by `INSERT ... ON CONFLICT DO UPDATE`. Each time the job and the step both
            re-open, and the target is processed once. A Langfuse trace that reappears after its
            target is done is deleted once more. An S3 key re-uploaded after its target closed is
            deleted, and its key is nulled again.
        - **Each step has its own generation, so a running step can't checkpoint `done` past a
          new target.** The job's generation guards only the close. A worker deleting recording R1
          decides "every target done" from what it read. Under `READ COMMITTED` that read misses
          a handler's uncommitted R2, and a guard over a subquery on targets isn't re-run when the
          `UPDATE` re-checks its row. The step would commit `done`, and the close would then match
          the new job generation, which already includes R2. So:
          - The re-open also bumps the target's step's `generation`, sets the step `pending` and
            sets its `next_attempt_at` to now, whatever its state, `inputs_expired` included,
            under the rule below.
          - **The step re-open and `inputs_expired`.** An erase completes, and the identifiers
            are deleted once the declared readers are done. Weeks later job J2, whose invoices
            were synced as SalesReceipts, is re-linked to the subject, and the mover adds the
            receipts as QuickBooks targets. If those targets needed the identifiers, the step
            would end `inputs_expired` without sending the update, and every later QuickBooks
            target would meet a step that no re-open may touch. So:
            - Each target records whether processing it reads the identifiers. A known-id
              QuickBooks customer or receipt doesn't: its read-back checks that each field holds
              the value the step wrote (see "Read it back before the target is done" below).
              The targets that do are the declared readers' identifier work: a lost-create
              query, a legacy-row match, a reader candidate's confirmation, and the content
              matches (the historical scan, the identifier-linked stores, ElevenLabs, the
              SendGrid suppressions and the final re-scan).
            - The transaction that deletes the identifiers also stamps `identifiers_deleted_at`
              on the job row, so no other path has to read their table. A path that adds a
              target that reads the identifiers, once that stamp is set, inserts it as
              `inputs_expired`. No trigger fires, and the result lists it.
            - Any other target re-opens its step from any state, `inputs_expired` included. The
              step processes the targets that are ready, leaves its expired targets as they are,
              and ends `inputs_expired` again if any remain. The daily retry and the repeat
              `POST` add no target, so they still leave an `inputs_expired` step alone.
            - Test: two late QuickBooks targets arrive after the identifiers are deleted. Both
              receipts are anonymized, and another job's inbox row in the same tenant is still
              moved.
          - The worker reads the step's generation before it reads the step's targets.
          - The step's terminal transitions (`done`, `incomplete`, `provider_retained`) are
            guarded on that generation, a column of the step row itself, never on a subquery over
            targets. One that matches no row re-reads the step's targets and carries on.
        - The close is guarded on `generation = $read_generation`, the value the worker read
          before it checked the steps, and on no step being non-terminal. Either the close sees the
          new target, or the re-open sees the closed job and re-opens it. A close that matches no
          row re-reads the steps and carries on.
        - The close also requires that no late-link inbox row of the job is unmoved, read after
          the job-row lock. The late-link trigger touches no job row, so the generation guard
          can't see a committed inbox row. The mover moves inbox rows under the job-row lock,
          so the two serialize. An inbox row still uncommitted at that moment is moved later,
          and the mover's re-open re-opens the closed job.
        - **One lock order: the job row first.** Two transactions that take the job row and
          another U7 row in opposite orders deadlock. For example, a Twilio messages checkpoint
          renews the lease and then moves a dispatch row from `sending` to `ambiguous`, while that
          message's status callback records the SID on the dispatch row and then re-opens the job.
          Postgres aborts one of them, and if it aborts the callback, Twilio doesn't retry it, so
          the SID link is lost. So every U7 transaction that touches a job row takes it first,
          before any step, target, cleanup or dispatch row:
          - Every worker checkpoint renews the lease as its first statement.
          - A handler that may add a late target finds its jobs with an unlocked read, then
            locks them (below) before it touches any other row. The trigger's own job-row
            `UPDATE` then finds the lock already held.
          - A handler that learns of a job only after it has locked another row rolls back and
            starts again, job rows first.
          - Inside the trigger and the re-open, the job row comes before the step row.
        - **Several job rows lock in ascending id order, all up front.** One key can belong to
          several jobs. Customers A and C share a household email and are both erased, so a
          shared lead's sends that started after phase 1 are targets of both jobs. Status
          callbacks for two of those messages arrive together. Each finds jobs {A, C} with an
          unlocked read that has no order, or relies on the step-target triggers, which lock in
          insert order. One updates A then C, the other C then A, and Postgres aborts one with
          `40P01`. A status callback isn't retried, so that SID link is lost. A SendGrid batch
          with events for rows of different jobs, the recording refusal path ("every job whose
          tombstone holds the matched key") and the per-tenant sweeps meet the same cycle. So:
          - A transaction that touches more than one job row locks all of them first, before
            any other U7 row, with one `SELECT id FROM customer_erasure_jobs WHERE tenant_id =
            $t AND id = ANY($ids) ORDER BY id FOR NO KEY UPDATE`. Postgres locks the rows in the
            sorted order. The transaction then adds its targets in that order.
          - A re-read after the locks that finds a job outside the locked set rolls back and
            starts again with the larger set.
          - A provider batch, such as a SendGrid event batch, is handled one event per
            transaction.
          - The per-tenant sweeps lock their job set the same way: the job claim, the daily
            retry, identifier retention and the alert stamps. The inbox mover runs one
            transaction per job (see "The inbox mover collects what hangs under a late link"
            below).
          - Every handler that may add a late target locks its job rows first and retries its
            transaction once on `40P01`, as `withErasureFence` does: the SMS and call status
            callbacks, the call bridge callback, the email-event, recording, voicemail,
            Wisetack and Vapi webhooks, and the S3 object-created worker.
          - Test: two handlers that each add targets to the same two jobs, discovered and
            inserted in opposite orders, both commit with no `40P01`.
        - **Job rows are locked `FOR NO KEY UPDATE`, never `FOR UPDATE`.** A tombstone, inbox,
          step, target or candidate insert checks its composite foreign key to
          `customer_erasure_jobs` by taking `FOR KEY SHARE` on the job row, and `FOR KEY SHARE`
          conflicts with `FOR UPDATE`. Say the mover holds S's job J with `FOR UPDATE` while it
          collects under J2. A Stripe webhook inserts a payment on one of J2's retained
          invoices. Its `BEFORE` trigger takes the invoice's stripe in shared mode, and its
          `AFTER` late-link trigger inserts a tombstone row and an inbox row for J, whose
          foreign-key checks wait on the mover. The mover then asks for that stripe in exclusive
          mode and waits on the payment. The payment began waiting first, during the
          collection, so its deadlock check fires first, and Postgres aborts the payment with
          `40P01`. The same cycle forms when `withErasureFence`'s claim transaction, still
          holding its shared stripes, inserts a held send's candidate row for J. So:
          - Every explicit job-row lock is `FOR NO KEY UPDATE`. Every job-row writer in this
            unit (lease renewal, generation bump, re-open, close, stamps) is a plain `UPDATE`,
            which takes the same strength, so they still serialize with each other, and none
            conflicts with `FOR KEY SHARE`.
          - No `UPDATE` changes a job's `id`, `tenant_id` or `customer_id`. Changing a column
            under a unique index that a foreign key can use upgrades an `UPDATE` to
            `FOR UPDATE`.
          - A structural check fails on `FOR UPDATE` or `FOR SHARE` against
            `customer_erasure_jobs`.
          - The mover's and the lead step's deadline starts when they are granted the job row,
            and their collection runs under the same `statement_timeout` (see "The budget is a
            wall-clock deadline" below).
          - The late-linking write paths retry their transaction once on `40P01`, like the
            trigger-bearing paths on a live call.
          - Docker-gated test: the mover holds a late-linked job and waits on an invoice's
            stripe while a payment is inserted on that invoice, and both commit with no `40P01`.
            So does a held-send candidate insert made during the mover's collection.
        - **The order is checked at runtime.** Nothing else catches a new handler that writes a
          dispatch row and then re-opens a job. So:
          - The job-lock helper, which every lease renewal goes through too, sets
            `set_config('erasure.jobs_locked', '1', true)`. It raises when the transaction has
            already written a U7 row or a dispatch or claims row, which their triggers flag with
            `erasure.u7_written` the same way.
          - A `BEFORE UPDATE` trigger on `customer_erasure_jobs` raises unless
            `current_setting('erasure.jobs_locked', true) = '1'`, so every job-row update, the
            re-open trigger's included, needs the helper first. Each check reads `= '1'`, as
            U8's flags do.
          - Any integration test on a path that breaks the order then fails. A test-only path
            that writes a dispatch row and then calls the helper raises.
        - The sweep also claims any job that has a non-terminal step, whatever the job's state.
        - The close writes `erase_completed` or `erase_incomplete` once per close generation. A
          re-opened job that closes again records its new outcome.
      - **The raw identifiers outlive the `customers` scrub, encrypted, until every step that
        reads them is finished.** Several steps match by name, phone and email: the historical
        `ai_runs` content scan, the identifier-linked leads and inbound messages, the final
        re-scan, and the QuickBooks lost-create queries and legacy-row match (see "QuickBooks:
        idempotency through `requestid`" below). The tombstone keeps only keyed hashes, and the
        `customers` scrub removes the originals, so a resumed step would have nothing to match.
        So:
        - Phase 1 stores them encrypted with `encrypt` (`integrations/crypto.ts:15`), in a table
          of their own, `customer_erasure_identifiers`, one row per job, keyed by `(tenant_id,
          job_id)`, with forced RLS and the composite foreign key to the job. It is on the
          catalog test's exception list of job-child tables with no step foreign key.
        - **The readers come from the manifest, not from a list in prose.** Each step declares
          whether it reads the identifiers. A hand-kept list left out the QuickBooks step. That
          step ended `incomplete` while QuickBooks was down, the listed readers finished and
          deleted the identifiers, and the next day's retry found them null and ended
          `inputs_expired`, which no retry touches. The QuickBooks customer would keep the name,
          email and phone for good.
        - **One accessor decrypts them, so a test can tell who reads them.** They are decrypted
          with the same generic `decrypt` (`integrations/crypto.ts`) as every other encrypted
          column, so a test over `decrypt` calls can't tell which call reads them. A new step
          that reads back by name, left undeclared, passes its tests, because the identifiers
          are still present while they run. In production the declared readers finish first, the
          identifiers are deleted, and the new step ends `inputs_expired`. So:
          - Steps read them only through `readErasureIdentifiers`, which throws unless the
            manifest declares the step a reader.
          - **No repository can hand them out by accident.** The job claim follows
            `pg-proposal.ts:644-655`, an `UPDATE ... RETURNING *` passed to `mapRow`. On the job
            row, a claim written that way would put the encrypted identifiers on the job object
            every step receives, without naming their column, and a new step could call the
            generic `decrypt` on them. So they live in `customer_erasure_identifiers` (above),
            which no repository maps. A structural test, following U8's one-ceiling-writer
            pattern, fails on any SQL against that table outside the accessor and the
            transaction that deletes them, `SELECT *` and `RETURNING *` included.
          - **The step id is bound by the runner, not passed by the caller.** A shared matcher
            could call `readErasureIdentifiers(job, 'historical_ai_runs')` with a hard-coded
            id, and an accessor that trusts its argument would accept it. So the step runner
            hands each step an identifier reader bound to that step's registered id, and the
            scan fails on any other import of `readErasureIdentifiers`.
          - The per-step test runs each step with the identifiers present only for declared
            readers.
        - **An undecided candidate whose confirmation reads them is an open read.** A QuickBooks
          create's outcome is unknown. The `DisplayName` query finds an inactive customer, but
          the `PrimaryEmailAddr` query finds nothing, because the bookkeeper changed the email.
          The customer goes on the candidate list, and the QuickBooks step ends `done`. The other
          readers finish, and that transaction would delete the identifiers. The owner confirms
          the candidate the next morning, and its confirmation step must re-check the customer
          against the identifiers before the irreversible anonymize, since the bookkeeper may have
          changed the record since the match. It would find them null and end `inputs_expired`,
          and the customer would keep the name, email, phone and addresses for good. Candidates are
          reviewed after the result appears, so this is the normal order. So:
          - The manifest declares, for each candidate kind, whether its confirmation step is a
            reader. A QuickBooks customer candidate's is.
          - The accessor's rule and its structural test cover those confirmation steps like any
            other reader.
          - Test: a QuickBooks candidate confirmed after every other reader is `done` is
            anonymized and reads back clean.
        - They are deleted in the transaction that leaves every declared reader `done` or
          `provider_retained`, no reader candidate undecided, and no late-link inbox row of the
          job unmoved, read after the job-row lock, as for the close. An undecided reader candidate
          keeps them until the owner confirms or dismisses it. An `incomplete` reader keeps them,
          because the daily retry will re-open it. Neither keeps them past their maximum
          retention (below). The result says so.
        - Test: the QuickBooks step ends `incomplete` while every other step is `done`. The daily
          retry runs with QuickBooks back up, and the inactive QuickBooks customer is found and
          anonymized.
      - **Each step is a checkpoint, and so is each target inside it.** A step moves `pending →
        running → done`, or ends `incomplete`, `provider_retained` or `inputs_expired`. Each
        target records its own
        outcome and an idempotency key, `erase:<job id>:<step>:<target id>`, written before the
        provider call. On resume:
        - A delete whose target is already gone counts as done, by each provider's own meaning of
          "gone", and only when the answer comes from the account the target lives on (below).
          The crash test kills the process between a delete and its checkpoint, so the repeat
          delete must read as done:
          - Twilio: a 404 (error 20404).
          - Stripe: a 404 `resource_missing`, or the customer returned with `deleted: true`.
          - Google Calendar: a 404, a 410 Gone, or the event returned with `status: "cancelled"`.
            A repeat delete gets 410, not 404.
          - S3: see "On a versioned bucket a HEAD 404 proves nothing" below.
          A Stripe Customer, Twilio Call or calendar event that an earlier run deleted is
          recognised as done, not reported as a failure.
        - **Every external target records the account it lives on.** Twilio puts the account in
          every resource URL (`/Accounts/{AccountSid}/...`), so a SID asked for under another
          account returns 404, and `Recordings?CallSid=` returns an empty list. Sends with no
          `tenantId` go out on the global account, and tenant sends on the tenant's own or
          subaccount (`notifications/per-tenant-twilio-delivery-provider.ts:61-63`, `:72-119`).
          `message_dispatches` and `voice_sessions` store no account. A tenant that moved from the
          platform number to its own subaccount would have its older SIDs deleted with the wrong
          credentials, each 404 counted done. A Stripe saved-card customer lives on the connected
          account (`payments/stripe-saved-card.ts:93-95`), so after a reconnect a `DELETE` under
          the new `Stripe-Account` returns 404 too. So:
          - Whatever path records a target (`snapshot`, a late target, a write-ahead row or a
            status callback), it records the account. For Twilio that is the `account_sid` from
            the create response, the callback's `AccountSid`, or the account in `recording_url`.
            For Stripe it is the `Stripe-Account` scope.
          - A SID stored before this change, with no account, is looked up on each account the
            tenant is known to have sent from. The step records the account it finds it on before
            it deletes it.
          - The step deletes and lists on that account's credentials. A 404 or `deleted: true`
            counts as done only when it comes from that account.
          - When that account's credentials are gone, or no known account has the SID, the target
            ends `provider_retained` with that reason, never `done`.
          - **QuickBooks: the realm.** `accounting_integrations` has one row per tenant, and its
            upsert overwrites `realm_id` in place on a reconnect
            (`integrations/accounting/repository.ts:290-322`). `accounting_sync_log` rows are
            keyed by `integration_id` and carry no realm (`findExternalIdForEntity`, `:483-499`).
            QuickBooks entity Ids are per-company sequences. So after a reconnect from company A
            to company B, Jane's Customer Id "58" from A names some other customer in B, and an
            anonymize there would blank that person's name, email, phone and addresses, past
            undoing. Its read-back would find none of Jane's identifiers and mark the target done,
            and a lost-create query in the wrong realm finds nothing, which counts as proof of
            absence. So:
            - Every `accounting_sync_log` push, and every QuickBooks claim, records the
              `realm_id` it was sent to. `snapshot` copies it onto the target.
            - The QuickBooks step, its lost-create queries and its read-back included, runs only
              when the integration's current realm equals the target's. Otherwise the target ends
              `provider_retained`: "the record stays in QuickBooks company <realm>, which is no
              longer connected".
            - A legacy row with no realm, synced after the integration's current `connected_at`,
              was sent to the current realm. An older one is anonymized only when the GET's
              `DisplayName`, after stripping a trailing " (deleted)" (see "QuickBooks renames
              an inactive customer" below), or its `PrimaryEmailAddr` matches the job's
              encrypted identifiers. Otherwise it goes onto the candidate list.
            - Test: after a reconnect to a second mock company that holds a different customer
              with the same Id, that customer is untouched and the store reports
              `provider_retained`.
          - **Google Calendar: the Google account and the concrete calendar.** `calendarId`
            defaults to `'primary'` (`integrations/calendar-integration.ts:152`, `:333`), which
            Google resolves to the primary calendar of whichever account issued the token. A
            reconnect upserts the technician's row and overwrites `external_account_email` and
            `calendar_id` (`:314-321`). `user_calendar_integrations` has no `connected_at`
            (`db/schema.ts:2287-2302`). A technician who pushed Jane's appointment as
            work@a.com and later reconnected as personal@b.com would have the step list b.com's
            calendar, find nothing and count it done, while the event with Jane's name and
            address stays in a.com's. The integration is active, so the revocation rule never
            applies. So:
            - Each calendar claim and `appointment_calendar_events` row records the Google
              account (`external_account_email`, or the token's `sub`) and the concrete calendar
              id that `'primary'` resolved to at insert.
            - The calendar step lists and deletes only with credentials for that same account.
              When the technician's integration now belongs to another account, the target ends
              `provider_retained`: "the event stays in <account>, which is no longer connected".
            - A legacy row with no recorded account is listed on the current account, and any
              match is deleted. When that listing finds nothing, the target ends
              `provider_retained` ("the event may stay in a Google account connected earlier"),
              never `done`.
            - Test: push under account A, reconnect as account B, erase. The store reports
              `provider_retained`, not `done`.
          - Test: a message sent on the global account, and a Stripe customer on a previously
            connected account, are both deleted. A 404 from another account is not counted done.
        - A provider write that isn't a delete sends that key wherever the provider accepts one, and
          writes the same value every time. The anonymized QuickBooks `DisplayName` is always the
          same `Erased customer <short id>`. A provider that replays its first answer for a
          repeated key, as QuickBooks does, gets a new key after a definite rejection (see "A
          reused `requestid` replays its first answer" below).
        - A local scrub commits its writes and its checkpoint in one transaction. A batched scan,
          such as the historical `ai_runs` scan, checkpoints its cursor with each batch. Candidate
          rows are unique on `(job_id, store, row id)`, so a re-run never lists one twice.
        - Provider calls run between transactions, never inside one (`workers/tenant-query.ts:11-12`).
      - **One worker per job, by lease.** A worker claims a job with one guarded update. It sets
        `lease_owner`, `lease_expires_at` and a new `lease_epoch`, and matches only a job that has
        no live lease, read with `clock_timestamp()`, and either isn't terminal or has a
        non-terminal step.
        - **Every checkpoint renews the lease on the job row, in the same transaction.** A guard
          that only reads the job's `lease_epoch`, such as an `EXISTS` on the target's update,
          takes no lock on the job row. Under `READ COMMITTED` it can pass beside a re-claim that
          hasn't committed yet, and it never notices a lease that lapsed but hasn't been re-claimed.
          Two workers would then call the provider for the same target. So:
          - Each checkpoint, including the one a target makes before its provider call, runs
            `UPDATE customer_erasure_jobs SET lease_expires_at = clock_timestamp() + <lease> WHERE
            id = $1 AND lease_epoch = $e AND lease_expires_at > clock_timestamp()` with its own
            write, as its first statement (see "One lock order: the job row first" above).
          - That takes the job row's lock, so it serializes with a claim. Either the checkpoint
            commits first and the claim finds a live lease, or the claim commits first and the
            checkpoint matches no row.
          - A checkpoint that matches no row rolls back its own write, and the worker stops before
            its next provider call.
        - A call that a stale worker already had in flight repeats harmlessly, by the rules above.
        - The lease outlasts the longest single provider call. The pre-call checkpoint renews it,
          so every call starts with a full lease ahead of it.
      - **A wait is a checkpoint, not a sleep.** A step that has to wait records when to look again
        (its own step row's `next_attempt_at`), releases its lease and returns. Examples: a call
        still in progress, an upload window not yet over, a drain window, an ambiguous send not yet
        linked. No worker holds a lease, a connection or a lock across a wait.
        - **`next_attempt_at` is per step, so a wait can't push back a re-open.** On the job row, a
          wait checkpoint would overwrite the "now" that a late target's re-open had just set. Both
          take the job row first, so they serialize, and the wait commits second. The re-opened
          step, say a recording that a refused callback registered, would then wait out the other
          step's interval, which behind a Twilio 20009 wait could be hours. So each step row has
          its own `next_attempt_at`, a wait writes only its own step's, and the sweep's due test
          runs over the steps (below).
        - Test: a late target committed while another step is about to wait is processed on the
          next sweep pass, not after the wait.
        - **A time gate is its own column, and a re-open never moves it.** Some waits are not
          retries but conditions of a proof: the Twilio recordings step's `not_before` (the
          call's completion plus the recording-callback window), the Langfuse send-and-ingest
          bound, the `idempotency_keys` lifetime, an upload window, and a writer's drain window
          before a reconciliation read. Held only in `next_attempt_at`, each would be cut short
          by a late target's re-open. A refused recording callback at +30 s would re-open the
          recordings step, which would delete that recording, list `Recordings?CallSid=` before
          a second recording on the call was finalized, find nothing, and checkpoint `done`. So:
          - Each gate is a column of its own, on the step or on the target, set when the wait
            first starts. A re-open moves only `next_attempt_at`.
          - A run that starts before a gate processes only the targets that are ready. Until
            every gate on the step has passed, it runs no listing or reconciliation read that
            counts as proof of absence, and it doesn't checkpoint `done`.
          - Test: a refused recording callback re-opens the step at +30 s. The step isn't `done`
            before its `not_before`, and a recording finalized after that early run is still
            listed and deleted.
      - **Every wait has a deadline, so no job waits forever.** A wait with no bound can keep a job
        running, with no alert, while `customer_erasure_identifiers` still holds the raw
        identifiers. An SMS whose client
        timed out before Twilio accepted it never gets a status callback, so "not yet linked" would
        otherwise repeat every few minutes indefinitely. So:
        - Each wait records a `wait_deadline` when it first starts, taken from the bound of what it
          waits on: an SMS's `ValidityPeriod` plus a carrier margin (see "Rows the callback never
          linked" below), the call `timeLimit` maximum, the end of an upload window (see
          "Presigned uploads" below), Langfuse's deletion processing, Twilio's finalization bound
          for error 20009, or the writer's declared drain window. A re-check never moves it.
        - Past its deadline, a wait takes its fallback or counts as a failure. An ambiguous send
          still not linked falls back to the strict content match below, and zero matches after
          that deadline is recorded as reconciled-absent. A call still in progress past the
          `timeLimit` maximum counts as a failure.
      - **A sweep resumes every started-but-unfinished erase** (the async worker pattern, P0-009):
        - Phase 1 enqueues an `erasure_job` message with `sendOn` inside its own transaction
          (`queues/pg-queue.ts:108`), so the work starts at once. The message only wakes a worker.
          The job row is the record, and the queue's retry limit and dead-letter queue never end an
          erase.
        - A leader-gated sweep (`runAsLeader` with a new `SWEEP_LOCK` key, `app.ts:2588`, `:2674`)
          runs once at boot and then every minute. It claims every job that has no live lease and
          either has a non-terminal step whose `next_attempt_at` has passed, or isn't terminal and
          has no non-terminal step left, so only its close remains.
        - **Every U7 sweep starts with no tenant, so every one uses U4's pattern.**
          `message_dispatches` has `FORCE ROW LEVEL SECURITY` (`schema.ts:1113-1114`), and so does
          every U7 table. A scan on the runtime role with no tenant set sees no rows. A released
          send would never go out, a hold would never expire and keep its stored message, and the
          S3 and Langfuse backstops would find nothing. So each sweep selects its due rows'
          `(tenant_id, id)` across tenants the way U4's purge does, then runs one transaction per
          tenant under that tenant's context, or one per job where a failure must not hold up the
          tenant's other jobs, as in the inbox mover. That covers:
          - the job claim, the daily retry and identifier retention
          - the late-link inbox mover
          - the release sender and hold expiry
          - the S3 prefix listing and the Langfuse re-query
          - every alert outbox: the close's, the age alarm's, the inbox-age alert's and the
            start-failure count's
          Each is tested at its entry point under `RLS_RUNTIME_ROLE=true`, with due rows in two
          tenants, as U8's reaper test is. A superuser test connection bypasses RLS, so a test on
          it proves nothing here.
      - **Retries are bounded, and the end state is explicit.**
        - **A crash counts as an attempt.** A failure counted only after a caught error never counts
          a step that kills the process, such as an out-of-memory on a large `ai_runs` batch or a
          `SIGKILL` during a deploy. The sweep would re-claim it after every lease expiry, forever.
          So the start checkpoint increments the step's `attempts` before the work runs. A run that
          ends in a wait checkpoint gives that attempt back in the same write. A caught error and a
          crash each count, and a wait doesn't.
        - **A success gives the budget back.** A run that ends `done` would otherwise keep its
          attempt. The S3 step of a customer with many uploads, re-opened by object-created
          notifications and the backstop listing, or the Twilio messages step re-opened by late
          SIDs, would climb toward the limit on runs that all succeeded. Its next transient error
          would then end it `incomplete` with no backoff retry. So a run that checkpoints `done`
          resets the step's `attempts` to 0 in the same write. So does every re-open that adds or
          re-arms a target, in the trigger, as the re-arm already does for the target. Test: a
          step re-opened more times than the retry limit, each run succeeding, still gets its
          full retries on a later transient failure.
        - A step that fails retries with capped exponential backoff.
        - After a fixed number of failures, the step ends `incomplete` with its last error.
        - **Some provider answers are waits or end states, not failures.** Counted as failures,
          they would end the step `incomplete`, and the daily re-open would alert again every day:
          - Twilio error 20009 ("Cannot delete this resource before it is complete") is a wait
            checkpoint, with a `wait_deadline` of the finalization bound Twilio documents for it
            (up to 14 days). It isn't a failed attempt.
          - **A rate limit is a wait.** A long-standing customer can have hundreds of SIDs, and the
            historical scan can add a Langfuse target for every pre-linkage run, so deletes come
            in bursts. Each of these is a wait checkpoint, not a failure: Twilio's 429 (error
            20429), a 429 from Stripe, QuickBooks or Langfuse, and Google's 429 or 403
            `rateLimitExceeded` / `userRateLimitExceeded`. Its `next_attempt_at` comes from
            `Retry-After`, or from the backoff when there is none, under a `wait_deadline`, and it
            gives its attempt back. Calls are paced per provider account, and historical Langfuse
            targets are deleted in batches through Langfuse's multi-trace delete.
          - A confirmed credential revocation ends the target `provider_retained`, with the
            reason "the record stays in the tenant's <provider> account, and we no longer have
            access". Confirmed means the integration is disconnected, or a token refresh fails
            with the provider's revoked-grant error, not a single 401. Examples: the tenant
            disconnected Google, Stripe or QuickBooks, or closed a Twilio subaccount. The close
            that records it marks the operator alert due, once for that close generation. The
            daily re-open doesn't touch it while the integration stays disconnected, and
            re-tests it once the integration reads as connected again.
          - **A QuickBooks refresh race is not a revocation.** Intuit rotates refresh tokens, and
            when two refreshes use the same refresh token, the first succeeds and the second gets
            `invalid_grant`. `AccountingSyncService.syncIntegration` reads the token pair once for
            its whole paged sweep (`integrations/accounting/sync-service.ts:81-86`).
            `refreshIfNeeded` refreshes from that copy with no lock and no re-read (`:135-156`),
            and a push error whose message contains "token" sets the integration `expired`
            (`:245-246`). The sweep and the erase's QuickBooks step can each get a 401 and refresh
            with the same token. The loser either reads `invalid_grant` as a revocation, or later
            marks a working integration `expired`, and either way the QuickBooks customer keeps
            the name, email, phone and addresses. So:
            - Refreshes are serialized per integration without a transaction held across the
              call (`workers/tenant-query.ts:11-12`). The refresher re-reads the stored pair. If
              another process has already stored a newer access token, it uses that one and
              doesn't refresh. Otherwise it claims the refresh with one guarded update on the
              `accounting_integrations` row: a short `refresh_claimed_until`, set only when no
              live claim exists and the stored refresh token is still the one it read. It commits,
              refreshes, and writes the rotated pair guarded on that claim. A process that loses
              the claim waits briefly and re-reads.
            - `invalid_grant` counts as revocation only when a re-read after the claim shows the
              stored refresh token is still the one that failed.
            - A refresh race never sets the integration `expired` or disconnected. The match on
              "token" in the message gives way to the typed revoked-grant result.
            - Test: the sweep and the erase step refresh at the same moment, and the QuickBooks
              customer is still anonymized.
        - Once every step is `done`, `provider_retained`, `incomplete` or `inputs_expired`, one
          guarded transition closes the job (guarded on its generation, above). It ends `completed`
          with `erase_completed` when no step is `incomplete` or `inputs_expired`, and
          `erase_incomplete` with that audit event otherwise.
        - The audit event is written in that transition's transaction, so a resumed job never writes
          it twice for the same close generation.
        - The transition to `erase_incomplete` also marks an operator alert due on the job row, by
          writing that close generation to `alert_due_generation`. The sweep sends every alert
          whose `alert_due_generation` is past `alert_sent_generation`, through `alertOperator`.
          Then it sets `alert_sent_generation` to the generation it read, guarded on
          `alert_due_generation` still being that value. So:
          - A crash right after the commit still alerts.
          - A job that re-opens, after a retry or a late target, and closes incomplete again has a
            new close generation, so it alerts again. No stamp needs resetting.
          - A close that lands between the send and the stamp makes the stamp match no row, and the
            next pass sends the new alert.
        - **Generations start at 1, and every due and sent column at 0.** With the usual `DEFAULT
          0` everywhere, a job inserted at `generation = 0` that closes `erase_incomplete` with no
          target ever added writes 0 to `alert_due_generation`, which isn't past
          `alert_sent_generation` 0, so no alert goes out. So phase 1 inserts the job with
          `generation = 1` and `opened_generation = 1`, and every `*_due_generation` and
          `*_sent_generation` column is `BIGINT NOT NULL DEFAULT 0`. Every close and every opening
          is then past its stamp.
        - **A job-age alarm, with its own outbox slot.** If it shared `alert_due_generation`, an
          age alert stamped at generation 7 would leave a later `erase_incomplete` close at 7
          unsent. And an age measured from phase 1 would fire at once on every re-open after the
          limit, such as the daily retry or a late object from the backstop listing. So:
          - The age runs from when the job last opened. Phase 1 sets `opened_at`, and
            `opened_generation` to 1 (above). A re-open that moves a terminal job back to `pending`
            stamps both again, and one that finds the job already open stamps neither. So a job
            stuck in its first opening compares `age_alert_due_generation` 0 with
            `opened_generation` 1, and its alarm can fire.
          - The sweep marks the age alert due for any job still not terminal a fixed number of
            hours after `opened_at`. It writes `opened_generation` to `age_alert_due_generation`,
            guarded on that being below `opened_generation`. The number of hours is longer than
            the longest wait deadline plus the retry budget, so it fires only on a job that the
            rules above failed to end.
          - It sends and stamps `age_alert_sent_generation` the same way as the close's alert,
            guarded on `age_alert_due_generation` still being the value it read.
          - So the age alarm fires at most once per opening, and never takes the close's alert.
        - The owner sees which stores are incomplete, and why.
        - **An `erase_incomplete` job is retried automatically.** The sweep re-opens its incomplete
          steps on a fixed schedule, for example daily, by the same re-open as a late target.
          Sending `POST /api/customers/:id/erase` again is the owner's immediate retry. Either one
          resets the incomplete steps' failure counts, and steps already `done` stay done. Neither
          touches an `inputs_expired` or `provider_retained` step.
        - **The encrypted identifiers have a maximum retention**, for example 30 days after phase 1.
          When it passes, the sweep's retention pass deletes them, even from an unfinished job, in
          one transaction that takes the job row first. So:
          - It bumps `lease_epoch` and clears the lease in that transaction, so a worker mid-step
            has its next checkpoint refused and stops.
          - It moves each step that still needed them to `inputs_expired`, a terminal state of its
            own. The daily retry and the owner's repeat `POST` don't touch it. A late target
            re-opens it only when that target doesn't read the identifiers (see "The step
            re-open and `inputs_expired`" above). A target that finds the identifiers null ends
            `inputs_expired`, never `done`, and so does its step.
          - The job then closes `erase_incomplete`, which alerts once. The result reports those
            stores as incomplete, because their inputs expired, and an audit event says which they
            were.
        - The owner's confirmation of a candidate adds its row as a target of the job's
          confirmation step for that candidate kind (see "Every late-target path first makes sure
          its step row exists" above). It isn't run inline. The owner can instead dismiss a
          candidate ("this is someone else"), which closes it with no scrub.
        - **Every owner decision on an erase is owner-only and audited.** Confirming a candidate
          authorizes an irreversible scrub of a row that may be someone else's. Releasing a held
          send writes an exemption that weakens the fence (see "A held send has a durable release
          path" below), and dropping one discards a message. So candidate confirmation and
          dismissal, release and drop are owner-only, like the erase endpoint. Each writes an
          audit event (actor, job, row or source id, decision) in the same transaction as its
          change. The sweep that moves late-link inbox rows names the tombstone keys they added in
          that job's next step audit event.
        - Test: a non-owner gets `403` on confirm, dismiss, release and drop, and each decision
          leaves exactly one audit row.
      - **The tombstone fences whatever state the job is in.** Writers check the tombstone, never the
        job, and the tombstone is never lifted. So a slow, stuck or `erase_incomplete` job never
        weakens the fence.
        - Phase 2 holds no erasure lock across steps. Each step's transaction is short, so a long
          erase blocks no writer.
        - The fence refuses only writes that would put subject data back, so retained financial
          records keep updating however long the job takes.
        - **"Never lifted" is enforced in the database, for every principal.** A later
          data-minimization job could purge completed erasure jobs older than a year, deleting
          their tombstone rows first or through an `ON DELETE CASCADE`. The subject's
          owned-entity ids, session ids and recipient hashes would stop fencing, and a stale
          writer could reattach data with no step left to catch it. Grants to the runtime role
          alone don't stop that: `applyTenantContext` switches to `rls_app_runtime` only inside
          a tenant transaction (`db/rls-runtime-role.ts:63-71`), and cross-tenant work runs as
          `rls_cross_tenant` or the connection principal. A sweep written as one cross-tenant
          `DELETE` would run as one of those. So:
          - A `BEFORE UPDATE OR DELETE` trigger on the tombstone, and a `BEFORE DELETE` trigger
            on `customer_erasure_jobs`, raise for every principal.
          - Only `session_replication_role = 'replica'` skips them. The whole-tenant purge uses
            it, in deprovision (`tenants/deprovision.ts:205`) and the demo reset
            (`tenants/purge-walk.ts:113`). A structural test fails on `session_replication_role`
            anywhere else in `packages/api/src`.
          - Neither the runtime role nor `rls_cross_tenant` has `UPDATE` or `DELETE` on the
            tombstone, or `DELETE` on `customer_erasure_jobs`.
          - The tombstone's composite foreign key to the job is `ON DELETE RESTRICT`.
          - The catalog test asserts those grants, that foreign-key action, and that both
            triggers are enabled (`'O'`).
      - **The endpoint returns the job, not the result.** It responds `202` with the job id once
        phase 1 commits. The owner reads progress, each store's outcome and the candidate list from
        `GET /api/customers/:id/erase`. Every "erase result" in this unit means that job state.
  - **U7 starts with a data inventory, before any erase code.** Review keeps turning up one more
    store that holds customer data: service locations, custom-field values, converted leads, callback
    tasks, an external trace sink. That shows the scope has to be discovered systematically, not
    patched one store at a time. The first deliverable is a written inventory, reviewed on its own
    PR, of every place a customer's data can live, reached through any of six kinds of link:
    - **Direct:** a `customer_id` foreign key.
    - **Bare column:** a `%customer_id` column with no foreign key.
    - **Session- or call-linked:** keyed by the customer's `voice_sessions`, `call_sid` or
      conversation ids. For example, `call_me_back_tasks` (`schema.ts:3887-3901`) is linked only
      through `session_id`, yet it holds `caller_phone`, `caller_name`, `callback_message` and
      `intent_summary`. `call_usage_events` (`schema.ts:7058-7070`) holds `caller_phone`, keyed
      only by a `call_id TEXT` with no foreign key.
    - **Polymorphic:** an `entity_type` / `entity_id` pair that names the customer, or one of the
      customer's jobs, estimates or invoices. For example, `customer-mms/customer-mms-intake.ts:150-163`
      uploads each customer MMS image to S3 and creates a `files` row with `entityType: 'customer'`.
      The schema test also lists every `entity_type` / `entity_id` table, so each must be classified.
      The erase deletes those file rows and their S3 objects.
    - **Identifier-linked:** matched only by the customer's phone, email or name.
    - **External sinks:** S3 objects, Twilio recordings, Langfuse traces when
      `LANGFUSE_CAPTURE_CONTENT` is on, and Vapi when `VAPI_API_KEY` is set.
      `trace-exporter.ts` exports gateway inputs and outputs, including transcripts, under
      correlation and session ids.
      - **Vapi takes whole calls by routing, not by a call site.** Provisioning step 4.5 links
        every tenant number to a Vapi assistant (`workers/provision-twilio.ts:602-650`). Vapi
        then runs those calls on its own infrastructure. It keeps the call log, with the
        caller's number and the transcript, and records the call unless the assistant turns
        recording off. Locally, the end-of-call webhook inserts a `voice_sessions` row with
        only the Vapi call id (`integrations/vapi/webhook.ts:125-150`), with no customer link
        and no phone. The call-site scan sees only the assistant-config calls, because subject
        data reaches Vapi through Twilio number routing. So:
        - Vapi is a manifest entry marked as an integration whose data enters by routing.
        - **A Vapi call is a Twilio call too.** `linkPhoneNumber` imports the tenant's Twilio
          number into Vapi with `provider: 'twilio'` (`integrations/vapi/client.ts:96-104`), so
          every Vapi call still arrives at Twilio as a Call resource on that account, with the
          caller's number as `From`. Vapi gives the call its own id and carries the Twilio
          `CallSid` as the call's `phoneCallProviderId`. The webhook stores only the Vapi id,
          only from the end-of-call report (`integrations/vapi/webhook.ts:125-150`), and ignores
          every non-terminal event (`:166-170`). An end-of-call report can be missing, after a
          failed delivery or a call that ends without one. Then the Twilio parent leg, any
          transfer's child leg and the Vapi recording and transcript would never be targets.
          So:
          - The webhook records the Vapi call id, its `phoneCallProviderId` and the Twilio
            account on the `voice_sessions` row from the first call event it receives, not
            only from the end-of-call report. It records the caller's keyed phone hash, and
            links the customer when the number resolves to one.
          - `snapshot` adds each subject Vapi call id as a Vapi target, and its `CallSid` as a
            Twilio Call target, whose child legs and recordings the Twilio steps find as for any
            call (see "Child legs are found through Twilio's own parent link" below).
          - As a backstop, the Vapi step lists Vapi calls on the tenant's `phoneNumberId` over
            the subject's activity window, and the Twilio calls step lists Calls to the tenant's
            numbers from each subject phone over the same window. A match by number alone goes
            onto the candidate list, under the household rule.
          - **A call that ends after phase 1 is still targeted.** Its first event or its report
            can arrive after `snapshot`, and its `voice_sessions` write then drops the subject
            link (see "A write that links new data to the erased subject" below), so `snapshot`
            never sees it. So the webhook first finds and locks the jobs whose tombstone holds
            the caller's customer id or phone hash. When the call resolved to the subject, it
            adds the Vapi call id and the `CallSid` as late targets on each of those jobs. When
            it matched only a recipient hash, it puts the call on that job's candidate list.
          - Test: a Vapi-routed call whose end-of-call report is dropped still has its Twilio
            parent and child legs deleted, or candidate-listed. A report that arrives after
            phase 1, for a call identified as the subject, leaves that Vapi call deleted, or
            `provider_retained`, before `erase_completed`.
        - A Vapi step deletes each call through Vapi's call API and re-checks it. Where that
          can't be confirmed, the target ends `provider_retained`.
        - The alternative is a boot guard that requires the assistant to be created with
          recording and transcript storage off (the PRIV-6 acknowledgement shape). Owner
          decision 1 picks one.
        - U8 covers Vapi's spend (see U8's "Every `externalSinks` entry declares its spend").
      Two business integrations hold directly linked customer records too:
      - **Stripe.** `payments/stripe-saved-card.ts:84-124` creates a Stripe Customer with the
        customer's name, email and internal id, and attaches saved cards to it. The erase deletes
        that Stripe Customer, which also detaches its saved payment methods. Stripe keeps its own
        charge records under its legal obligations, outside our control, and the result says so.
        - **Payment Link products are named after the customer.** Invoice and estimate-deposit
          links send `product_data[name]` as `Invoice <n> — <customer.displayName>`
          (`invoices/public-invoice-service.ts:354`, `:387`;
          `estimates/public-estimate-service.ts:889-891`, `:914`). `price_data` creates a new
          Product inline, on the platform or the tenant's connected account, and the live link
          page shows that name to anyone with the URL. A Product isn't a charge record, and it
          can be renamed. So:
          - The product name carries only the invoice or estimate number, never the display
            name.
          - **Every link ever minted is a target, not only the current one.** A link is retired
            when its invoice is credited, voided or switched to collect-on-site.
            `retireCheckoutLink` deactivates it at Stripe, then `clearPaymentLinkIfMatches`
            nulls the stored id (`invoices/invoice-payment-link.ts:193`, `:363-371`), and the
            next Pay Now mints another. A concurrency loser's link is deactivated and never
            stored (`invoices/public-invoice-service.ts:332-336`), and the code notes that
            nothing persists which account a link was minted under
            (`invoice-payment-link.ts:285`). Deactivating a link deletes neither the link nor the
            Product its `price_data` created, so every Product minted before the name change
            above keeps the customer's name. So:
            - Each payment-link create writes an append-only row per invoice or estimate before
              the call, with the `Stripe-Account` scope, and fills in the link id once it
              returns. Nothing clears these rows.
            - `snapshot` takes every such row of a subject invoice or estimate as a Stripe target.
            - For links minted before those rows existed, `snapshot` also reads the
              `invoice.payment_link_*` audit rows of subject invoices, and lists `GET
              /v1/payment_links` on the platform and on every connected account recorded for the
              tenant. It keeps the links whose `metadata.invoice_id` is a subject invoice, or
              whose `metadata.estimate_id` is a subject estimate for a deposit link
              (`estimates/public-estimate-service.ts:917-919`).
            - A row whose create response was lost is reconciled by that same listing.
            - Test: a link retired by a credit and then re-minted has both Products renamed.
          - The Stripe step reads each link's line items (`GET
            /v1/payment_links/:id/line_items`) for its Product, renames the Product to the
            anonymized value (`POST /v1/products/:id`), and confirms with a GET that no
            identifier remains.
          - Each Checkout Session's line-item snapshot is listed as `provider_retained`, under
            Stripe's charge-record retention.
          - The seed-and-erase test seeds a payment-link Product named after the subject.
      - **QuickBooks.** `integrations/accounting/sync-service.ts:271-315` pushes the customer's
        display name, email and phone. Accounting records fall under the same tax and legal
        retention as local invoices (owner decision 1). The default is to keep the financial
        records and anonymize the QuickBooks customer record:
        - Replace the required `DisplayName` with a stable anonymized value, for example
          `Erased customer <short id>`. `sync-service.ts:282-287` sends `customer.displayName`, and
          `quickbooks-client.ts:93-103` stores it as `DisplayName`, so clearing email and phone
          alone leaves the name.
        - Clear the email and the phone.
        - **Set `PrintOnCheckName` to the same anonymized value.** `createCustomer` sends only
          `DisplayName`, `PrimaryEmailAddr` and `PrimaryPhone` (`quickbooks-client.ts:93-103`).
          Intuit's Customer reference says `PrintOnCheckName` is filled from `DisplayName` when it
          isn't given, and can't be removed with a sparse update. So every customer we pushed
          still prints checks to "Jane Doe" after the `DisplayName` changes.
        - **Overwrite every name and contact field, not only the ones we sent.** The tenant's
          bookkeeper can fill more in QuickBooks. The update sets `GivenName`, `MiddleName`,
          `FamilyName`, `CompanyName`, `PrintOnCheckName`, `PrimaryEmailAddr`, `PrimaryPhone`,
          `Mobile`, `AlternatePhone`, `Fax`, `BillAddr`, `ShipAddr` and `Notes` to the anonymized
          value or an empty one.
        - **Read it back before the target is done.** The step GETs the customer and checks that
          each of those fields holds the value the step wrote, the anonymized value or empty,
          after stripping a trailing " (deleted)" (see "QuickBooks renames an inactive customer"
          below). A field that holds anything else leaves the target pending. This read-back
          needs no identifiers, so a known-id target can still be processed after they are
          deleted (see "The step re-open and `inputs_expired`" above). The step is still a
          declared reader, for its lost-create queries and the legacy-row match.
        - **Sales receipts carry the line descriptions too.** Every synced invoice becomes a
          SalesReceipt whose `Line[].Description` is each local line item's description
          (`sync-service.ts:194-200`, `quickbooks-client.ts:122-145`). The local erase blanks and
          fences those descriptions, and a line such as "Water heater at 12 Oak St, gate code
          4411, ask for Jane" would otherwise stay in QuickBooks while the store reports `done`.
          QuickBooks can also fill a receipt's addresses from the customer record. So:
          - `snapshot` makes each SalesReceipt id in `accounting_sync_log` (entity type
            `invoice`) a QuickBooks target, with its realm.
          - **A receipt from a lost create is found by a query, not the sync log.**
            `createSalesReceipt` sends its key as a `Request-Id` header too
            (`quickbooks-client.ts:64-66`). On a timeout the push is logged as a failure with no
            receipt id, and the next sweep pushes the invoice again (`sync-service.ts:194-238`).
            If QuickBooks created SR 301 before the response was lost, the retry creates SR 302,
            and only 302 is logged. SR 301 keeps "gate code 4411, ask for Jane". So:
            - For each subject QuickBooks customer id in the target's realm, `snapshot` queries
              `select * from SalesReceipt where CustomerRef = '<id>'`, paged, and adds every
              receipt it finds as a target. For a customer a lost-create query finds later, the
              QuickBooks step runs the same query before it checkpoints `done`.
            - It also queries by `DocNumber` for each subject invoice number. A match whose
              `CustomerRef` isn't a subject customer goes onto the candidate list.
            - Receipt creates send `?requestid=` like customer creates, and the receipt create's
              claim declares that query as its reconciliation read.
            - The per-sink test drops a receipt create's response, and asserts that the orphan
              receipt is found and rewritten.
          - The step sends one sparse update that resends the whole `Line` array from its GET,
            with each `Description` replaced by the scrubbed value the local scrub writes, and
            clears `BillAddr`, `ShipAddr` and `BillEmail`. It follows the same `requestid` rules
            as the customer anonymize.
          - A read-back checks that every line and address field holds the value the step wrote.
          - If owner decision 1 keeps receipts verbatim, or QuickBooks refuses the edit in a
            closed period, the target ends `provider_retained` with that reason, never `done`.
          - The seed-and-erase test adds a receipt whose line description names the subject.
      - **Twilio calls.** Deleting recordings and messages still leaves Twilio's Call resource, and
        with it the call log of both parties' phone numbers. Twilio exposes a separate DELETE for a
        completed Call record, and deleting a recording doesn't remove it. So:
        - The erase deletes the subject's Call resources: the primary call, plus any child legs
          such as a dialed transfer or the on-call page.
        - It selects them only by the Call SIDs we keep linked to the subject:
          `voice_sessions.call_sid`, the `phoneCallProviderId` of a Vapi-routed call (see "A Vapi
          call is a Twilio call too" above), and the outbound call results we store. An outbound
          call whose create response was lost is linked by its own callback or fallback (see "An
          outbound call needs its own correlation" below).
        - **Child legs are found through Twilio's own parent link.** Escalations and owner
          patch-throughs use `<Dial>` (`ai/skills/escalate-to-human.ts`,
          `ai/skills/patch-owner-through.ts`), and Twilio logs a `<Dial>` as a separate child
          Call, by default with the caller's number as its caller ID. We keep a child SID only for
          an answered screened transfer, and then only in audit metadata
          (`telephony/transfer-screening.ts:71`). So for every subject Call SID, before it deletes
          that Call, the step lists `GET /Calls.json?ParentCallSid=<sid>` on that call's account.
          Each child becomes a Call target, and its recordings are listed with
          `Recordings?CallSid=` too. A child is deleted before its parent. That link is Twilio's
          parent relation, not a phone-number match.
        - A call still in progress can't be deleted. The erase waits for it to complete, up to the
          call `timeLimit` maximum, and until then the Twilio calls store is `incomplete`.
        - A Call is deleted only after the Twilio recordings step has asked Twilio for that Call's
          recordings (see "A writer the fence refuses can still leave a copy" below).
        - A 404 on the call's own account counts as done, and a re-check after the delete must
          come back clean.
      - **Twilio messages.** `notifications/twilio-delivery-provider.ts:238-268` posts the recipient
        and the body to Twilio's Messages resource, and we keep the returned message SIDs. The
        erase deletes the customer's SMS/MMS Message resources, media included, through the
        Twilio API.
        - **A delete, never a redaction.** Twilio offers both. A redaction, a POST that sets
          `Body` to an empty string, keeps the Message record with both numbers, the timestamps
          and, for MMS, the Media holding the customer's photo. A redacted Message still returns
          200, so a re-check would pass. Only an HTTP `DELETE` of the Message removes the record,
          and its Media with it. So:
          - The step always `DELETE`s the Message, and confirms with a GET that returns 404
            (error 20404) on the target's own account.
          - Redaction is only a fallback for a Message Twilio refuses to delete, other than the
            20009 wait (see "Some provider answers are waits or end states" above). The step then
            deletes each Media subresource explicitly, and ends
            the target `provider_retained`, naming the number Twilio keeps.
        - It selects them only by the message SIDs we keep linked to the subject: outbound sends,
          and inbound captures, which already store `messageSid` with `customerId`
          (`sms/inbound-capture.ts:293-309`).
        - It never selects them by phone number alone. A household can share a number and numbers
          get reassigned, so a number-only match could irreversibly delete someone else's history.
        - Unlinked inbound messages that match only on the number go onto the same owner-confirmed
          candidate list as historical `ai_runs`.
      - Every enabled integration is a manifest entry with its delete, anonymize or legally-retain
        rule.
      - **Copies a provider keeps anyway are reported as provider-retained.** Without this, the
        job can end `erase_completed` while providers still hold copies. Each `exempt` model or
        transcription provider, and each anonymized or deleted integration, has a manifest
        retention entry that the erase result prints, as it already does for Stripe, financing
        and email:
        - OpenAI keeps API inputs and outputs (chat, Whisper, speech and embeddings, all used
          here) in abuse-monitoring logs for up to 30 days, unless zero data retention applies.
        - **A model provider's retention entry is keyed by the endpoint that was configured, not
          by the call site.** The chat and embeddings call sites are one OpenAI-compatible
          adapter whose endpoint comes from `AI_PROVIDER_BASE_URL` and
          `AI_FALLBACK_PROVIDER_BASE_URL` at runtime, and the documented options include
          OpenRouter and "any other OpenAI-compatible endpoint" (`ai/gateway/factory.ts:36-57`).
          A tenant whose failover went through OpenRouter would otherwise get a result that says
          "OpenAI, 30 days". So:
          - Retention entries are keyed by endpoint host. A boot guard maps each configured base
            URL to an entry, and refuses an unlisted host in production or staging (the PRIV-6
            shape). OpenRouter's entry says it forwards to upstream providers whose retention
            varies.
          - Each boot records its configured endpoint hosts as intervals, like the capture-on
            intervals. The result prints the retention of every host configured while the
            subject's runs were made.
        - **ElevenLabs is a deletable store, not a fixed retention entry.** It receives the text
          it speaks (`ai/tts/elevenlabs-stream.ts:201`, and the REST synthesis in
          `ai/tts/tts-provider.ts`), which can read back the caller's name and address. Its stream
          was missing because it is a `ws` WebSocket, which the call-site scan didn't see (see "a
          transport value" below). ElevenLabs logs each request's text and audio to the
          account's history unless the request sends `enable_logging=false`, which needs its
          Zero Retention Mode. Each history item can be deleted. So one of these applies, and
          owner decision 1 names which:
          - Every request sends `enable_logging=false`, and a boot guard checks the account has
            Zero Retention Mode, the PRIV-6 way.
          - Or an ElevenLabs step pages `GET /v1/history` over the window of the subject's calls,
            matches each item's text against the subject's identifiers and ids by the
            corroborated-or-candidate rule of the historical `ai_runs` scan, deletes each match
            with `DELETE /v1/history/{history_item_id}`, and re-checks. A rate limit is a wait.
            The step is a declared reader of the identifiers.
        - **Backups keep what the erase removes.** Twilio documents that message bodies can
          persist in its database backups for up to 30 days after a `DELETE`. Our own Postgres
          and bucket backups hold everything the erase scrubs. A restore from a backup taken
          before phase 1 brings the customer's rows back with no tombstone and no job, so
          writers aren't fenced and no step runs again. So:
          - The result lists database and bucket backups, and Twilio's backup window, as
            `provider_retained` until their retention dates.
          - The job keeps a minimal erase record outside the restorable database: the job id,
            tenant id, customer id and phase-1 time, for example as one object per erase in a
            dedicated bucket that the database restore doesn't touch.
          - **The record is the job's first step, not part of phase 1.** A PUT can't commit
            with Postgres. Inside phase 1 it would be a provider call in the transaction that
            holds the exclusive stripes, under a sub-second deadline. Right after phase 1's
            commit, a crash or a deploy before the PUT would leave a job that completes with no
            record, and a later restore from an older backup would bring the customer back with
            nothing in the runbook to re-erase them. So:
            - Phase 1 creates an `erase_record` step row like every other step, and the worker
              runs it first: an idempotent PUT keyed by the job id, confirmed with a GET, retried
              and alerted like any provider step.
            - A failing record step doesn't hold up the scrub, but the job can't close
              `completed` until it is `done`.
            - Its call site is registered with a kind of its own, `erasure_record` (see "A
              registered entry is one of five kinds" below).
          - U7 adds a restore step to `docs/runbooks/rollback.md`: before the app takes traffic,
            start a new erase for every logged erase newer than the backup.
          - Test: kill the process right after phase 1 commits. After restart the worker writes
            the record first, and it exists before `erase_completed`. A simulated restore from a
            pre-phase-1 snapshot, followed by the runbook step, re-runs the erase.
        - Deepgram: no call site sets `mip_opt_out=true`. Deepgram asks for that flag on each
          request that should stay out of its Model Improvement Partnership Program, so the
          live-call audio and U4's PCI pass fall under it.
        - QuickBooks keeps the old `DisplayName`, email and phone in the company's Audit Log after
          the anonymize.
        - Google Calendar keeps a deleted event in the calendar's bin for about 30 days, where the
          technician can restore it. The result lists the calendar store as provider-retained in
          the bin until its purge date.
        - Owner decision 1 covers these defaults, including whether to set `mip_opt_out=true` on
          every Deepgram request and whether to seek zero data retention from OpenAI.

    The erase code and its tests are then written against that inventory. The list of stores below
    is a starting point, not the definition.
    - **External sinks are erased too, or the erase says it is incomplete.**
      - With content capture on, the erase deletes the subject's Langfuse traces through the
        Langfuse API, keyed by the collected correlation and session ids.
      - **The Langfuse step targets every trace that may exist, not only current ones.**
        - **Capture that has since been turned off.** Capture can be on for months, with the
          PRIV-6 acknowledgement, and then turned off. So each boot records when
          `LANGFUSE_CAPTURE_CONTENT` is on, as capture-on intervals. The step runs whenever any
          interval falls inside Langfuse's retention period, whatever the setting is now.
        - **A trace lives in the project it was exported to.** Langfuse API keys are scoped to one
          project, so a trace fetched or deleted with another project's keys returns 404. If
          capture ran into project A on Langfuse Cloud and the deployment then moved to project B,
          or to a self-hosted Langfuse, every delete and re-check would go to B and count A's
          traces clean. That is the wrong-account 404 ruled out above for Twilio and Stripe. So:
          - Each capture-on interval also records `LANGFUSE_BASE_URL` and the project of the
            public key in use.
          - Each Langfuse target is tied to the projects whose intervals cover its run's time. The
            step deletes and re-checks on those projects' keys, which a separate setting keeps for
            retired projects. A 404 counts as clean only from that project.
          - When a project's keys are no longer available, the target ends `provider_retained`
            with that reason.
          - Test: traces exported under project A are deleted in A after the config moves to B,
            and a 404 from B isn't counted done.
        - **Historical runs.** The trace id is the request's `correlationId`
          (`ai/gateway/trace-exporter.ts:7`), and pre-linkage runs have random correlation ids.
          So the correlation id of every `ai_runs` row that the historical scan scrubs, or that
          the owner confirms, is added as a Langfuse target.
        - **Runs U4 has already purged.** U4's purge scrubs `ai_runs` content past its window but
          never touches Langfuse, whose self-hosted retention is unlimited by default. The content
          scan can't match those rows any more, so their traces can't be found. Owner decision 1
          covers setting the Langfuse project's data retention to at most the `ai_runs` window.
          Until that is set, the result says that traces older than the last purge may remain,
          as `provider_retained` under Langfuse's retention.
      - The Langfuse SDK queues events synchronously and sends them later. A trace queued before
        the tombstone was written can therefore still go out after the external delete and recreate
        the trace (`trace-exporter.ts` exposes `flush()` only for shutdown). So the erase does four
        things:
        - flushes the exporter queue before the external delete, through a new erasure-specific
          drain. The existing `LangfuseTraceExporter.flush()` calls `shutdownAsync()` and swallows
          errors. Using it here would either shut down the process-wide exporter for good or fail
          silently. The new drain leaves the exporter running, waits for pending sends, and
          propagates any failure. A failure marks the store `incomplete` instead of reporting
          success.
        - applies the tombstone at the exporter's send boundary too, so queued events for the
          subject are dropped before transport
        - deletes again after the drain window
        - reports success only once that second delete and its re-check come back clean
      - **A self-hosted Langfuse with a versioned blob bucket keeps the raw events.** Langfuse v3
        stores ingested events and media in S3-compatible blob storage, and its data-retention
        docs say that on versioned buckets, delete markers and non-current versions must be
        removed by hand or by a lifecycle rule. A trace delete and its API re-check would come
        back clean while the event objects with the transcript stay as non-current versions,
        the same trap as "On a versioned bucket a HEAD 404 proves nothing" below. So:
        - In production or staging, the boot config guard refuses a self-hosted Langfuse unless
          an acknowledgement says its event and media buckets are unversioned, or names a
          noncurrent-version expiration of at most a fixed number of days (the PRIV-6 shape).
        - With the expiration acknowledgement, the Langfuse store ends `provider_retained` until
          that horizon after the delete, naming the bucket.
      - **The second delete waits by time, not on the drain.** The drain reaches only the process
        running the erase, and only while it lives. The gateway exports from every process, and a
        resumed job can't drain a queue that belonged to an earlier one. So the second delete is a
        job step with a `not_before`: the phase-1 commit time plus the SDK's longest send time,
        retries included, plus a declared ingestion-lag bound (below). By then every process's
        event for the subject has either been sent and ingested, so the second delete removes it,
        or been dropped at the send boundary.
      - **Langfuse ingests and deletes asynchronously, so each delete is confirmed after a wait.**
        A finished send only means Langfuse accepted the event. Ingestion is processed later, and
        events can take minutes to appear. A trace delete runs in the background, usually within
        about 15 minutes, with no confirmation (Langfuse's data-deletion docs). A re-check before
        an accepted event is ingested finds nothing and counts as clean, and a re-check right
        after a delete still sees the trace and burns a retry. So:
        - Each Langfuse delete is a delete, then a wait checkpoint, then a re-check. The wait's
          `wait_deadline` covers Langfuse's deletion processing, for example 1 hour.
        - **A backstop re-query.** Like the S3 listing, the sweep re-queries the subject's trace
          ids and session ids on a schedule for a fixed period after the step is done, for example
          daily for 7 days. A trace that reappears re-arms its target (see "A target that comes
          back re-arms its row" above), which re-opens the job.
        - Test: against a mocked Langfuse that ingests an event 10 minutes after accepting it and
          deletes 15 minutes after the call, the job completes only after the late event is
          deleted, and no re-check counts as a failed attempt.
      - If any external delete fails, the erase result reports that store as incomplete, the owner
        sees it, and `alertOperator` fires.
      - It never claims success it hasn't confirmed.
    - Build an erase-coverage manifest in code. It names every table that references `customers`.
      Foreign keys alone miss many links, because a lot of customer links in this schema are bare
      columns: `leads.converted_customer_id` (`schema.ts:1411`), `portal_sessions.customer_id`
      (`:1760`), and the bare `customer_id` columns at `:1611`, `:2963`, `:4171` and `:4243`. So the
      manifest covers three kinds of link:
      - every foreign key to `customers`, whether in a table definition or added later by
        `ALTER TABLE`
      - every column whose name ends in `customer_id`, foreign key or not, including external ids
        such as `stripe_customer_id` (classified `keep` or `anonymize` with a reason)
      - stores linked only by the customer's identifiers, such as an unconverted lead that matches
        the customer's phone or email. These are listed explicitly, with how each is matched.
    - Classify each table, with a reason, as exactly one of:
      - `scrub` (delete or blank its PII columns)
      - `anonymize` (keep the row and blank the PII, dropping the link where the column allows it)
      - `keep` (a legal or financial retention reason)
    - **Each `anonymize` table names how it treats its link.** Many link columns are `NOT NULL`:
      `service_locations.customer_id` (`schema.ts:340`), `jobs.customer_id` and `jobs.location_id`
      (`:370-371`), `estimates.job_id` (`:526`) and `invoices.job_id` (`:623`). Invoices and
      payments have no customer column at all; they reach the customer through the job. An
      `UPDATE` that nulls one of those links fails with `23502` on every retry, rolls back the
      blanking in the same statement, and leaves the PII. So:
      - `null-link` nulls the link, where the column is nullable.
      - `keep-link` keeps the link to the blanked `customers` row, and relies on the tombstone's
        owned-entity keys to fence its children. The `customers` row is therefore blanked, never
        deleted.
      - The schema test fails on an `anonymize` table whose link column is `NOT NULL` unless its
        method is `keep-link`.
    - A schema test reads the live catalog (`pg_constraint` for foreign keys, and
      `information_schema.columns` for every `%customer_id` column) in the Docker-gated suite. It
      fails when any match, or any newly added one, is missing from the manifest. A future table or
      bare link column therefore can't silently escape the erase.
    - **Every table is created by the migrations, so the catalog sees it.** `PgQueue` creates
      `_queue_messages` and `_queue_dlq` in `ensureTable` (`queues/pg-queue.ts:38-71`), kept out
      of the `MIGRATIONS` registry on purpose, and `flags/pg-feature-flags.ts:27` creates
      `_feature_flags` the same way. A freshly migrated test database doesn't have them
      (`test/integration/shared.ts:98` checks `to_regclass('_queue_messages')` for that
      reason), so the catalog tests would see them only in some test orders. So:
      - Those three tables move into `MIGRATIONS`.
      - A structural test fails on `CREATE TABLE` in `packages/api/src` outside `db/schema.ts`.
      - The queue tables are then classified like any other (see "The queue tables hold names,
        phones and message bodies" below).
    - **The manifest covers the whole customer-owned graph, not just direct links.** Many tables
      reach the subject only through another subject-owned entity. For example,
      `appointments.notes` and `job_timeline_events.description` / `metadata` link only through
      `job_id → jobs.customer_id`. So:
      - The schema test computes the transitive closure from `customers`, recursively over
        `pg_constraint`, and adds bare link columns named after a subject-owned table (`job_id`,
        `appointment_id`, `estimate_id`, `invoice_id` and so on).
      - Every table in that closure must have a manifest entry, a classification, and the erasure
        trigger if it is `scrub` or `anonymize`.
      - Test: a test-only migration adds a table linked only by `job_id`. The coverage test fails
        until the manifest classifies it.
    - **The catalog test also finds tables linked by the tombstone's other keys, or holding an
      identifier.** The closure from `customers` covers only foreign keys and bare columns named
      after a subject-owned table. `call_usage_events` holds `caller_phone` keyed only by
      `call_id TEXT`, and it can't flag that. So:
      - Any table with a column named `session_id`, `voice_session_id`, `call_sid`, `call_id`,
        `correlation_id`, `conversation_id`, `message_sid` or `recording_sid`, foreign key or not,
        must have a manifest entry.
      - So must any table with a column matching the identifier patterns (`%phone%`, `%email%`,
        `caller_%`, `recipient%`, `%_name`, `%address%`).
      - **So must any table with a `jsonb`, `json` or free `text` column**, outside a short safe
        list of enum-like status, type and kind columns. The safe list accepts a column only when
        it has an enum type, or a `CHECK` constraint that limits it to a literal set, read from
        `pg_type` and `pg_constraint`, never by name, so a `failure_kind text` that stores
        provider message text can't escape. The test parses `pg_get_constraintdef` and accepts
        only `col IN (...)` or `col = ANY (ARRAY[...])` over literals. A length, non-empty or
        pattern check doesn't count: free text under a length check is already common here,
        such as `voice_call_corrections.note` (`schema.ts:8456`) and
        `customer_text_wording.body` (`:8226`). Fixture: a `failure_detail text CHECK
        (char_length(failure_detail) <= 2000)` column is refused from the safe list. The list
        sits in the same reviewed snapshot as the `exempt` ids. A
        payload store holds the subject's data
        under no matching column name. `webhook_events` (`schema.ts:264-276`) has only `source`,
        `event_type`, `idempotency_key`, `payload`, `status` and `error_message`, no `tenant_id`,
        and nothing deletes from it. The Twilio route records the whole body, `From`, `Body` and
        `MediaUrl0` included, as `payload` (`webhooks/routes.ts:3237`, for `/twilio/sms/:tenantId`
        at `:3335`), and the SendGrid route stores whole event batches with recipient emails
        (`:3430`). So:
        - The Twilio and SendGrid receipt writers store only ids from now on, as the voicemail
          and LSA receipts already do (`telephony/voicemail-status-route.ts:387-392`,
          `lsa/lsa-webhook.ts:134-137`).
        - The erase blanks `payload` on the `webhook_events` rows keyed by the subject's message
          and call SIDs.
        - A leader-gated purge blanks `payload` on processed rows past a fixed window, no shorter
          than its readers need (`workers/money-reconciliation.ts` reads Stripe receipts). That
          covers older rows the erase can't link. The erase result lists `webhook_events` as held
          until the next purge date, like the calendar bin.
        - `idempotency_keys.response_body` (`schema.ts:7442`) caches API responses, such as a
          customer create, for 24 hours before the hold-reaper prunes them. A step with a
          `not_before` of phase 1 plus that lifetime plus the prune interval confirms that no row
          created before phase 1 is left.
        - The seed-and-erase test sends an inbound SMS and a SendGrid event through their routes,
          and asserts that neither receipt holds the subject's data once the job completes. A
          seeded legacy receipt with a full payload and no subject SID is listed as held, and the
          purge blanks it.
        - **The queue tables hold names, phones and message bodies.** A delay notice carries
          `customerName`, `destination` and `message`
          (`notifications/delay-notifications.ts:257-267`), an emergency page carries
          `callerPhone` (`telephony/emergency-page-retry.ts:66`), and MMS ingest carries
          `fromPhone` and `body` (`sms/tech-status/mms-ingest.ts:323-332`). `last_error` and
          `_queue_dlq.error` keep handler error text, and nothing deletes from `_queue_dlq`. A
          delay notice to Jane that fails three times while Twilio is down would keep her name,
          phone and message there for good. So:
          - The queue tables have no `tenant_id`, so they go on the pinned global list with a
            defined erase rule. A step deletes, or blanks `payload`, `error` and `last_error`
            on, every row whose `payload->>'tenantId'` is the tenant and whose payload holds a
            tombstone key (a customer, session, message SID or appointment id) or matches the
            subject's phone or email hashes in the value pass. The final re-scan repeats it.
          - A leader-gated purge bounds `_queue_dlq` by age, and errors are stored as codes.
          - A handler whose fenced write is refused acks its message, so the message never
            retries into the DLQ.
          - **A tenantless payload store meets the trigger rule another way.** The fence trigger
            probes by `(tenant_id, key)`, and these tables have no tenant column. So the rule
            that a subject-data table is `scrub` or `anonymize` with a fence trigger has one
            exception: a tenantless payload store on the global list, here the queue tables and
            `webhook_events`. Each has an erase step that finds its rows by the payload's
            tenant and keys, a purge that bounds its age, and writers whose own sinks are fenced
            when the message runs. Its entry on the global list names all three.
          - The seed-and-erase test seeds a dead-lettered delay notice for the subject.
      - `keep` with a reason is allowed.
      - Fixture: a test-only migration adds a table with only `call_id TEXT` and
        `caller_phone TEXT`, and the test fails until the manifest classifies it.
    - **Coverage is per column, not per table.** A migration that adds `customers.alt_phone`, or
      `service_locations.lockbox_code`, to a table that is already classified passes every
      table-level test. The scrub blanks only the designated list, and the trigger compares only
      those columns, so the new column would keep the subject's data and accept it again after
      the erase. So:
      - The manifest classifies every column of every table it lists, `keep` tables included:
        - A `scrub` or `anonymize` table's column is designated (blanked and fenced) or retained,
          with a reason.
        - A `keep` table's column is "no subject data", with a reason, or "subject data, blanked
          by the erase while the row is kept". Without this, a later `last_error text` on
          `customer_erasure_steps` that stored "Duplicate Name Exists ... Jane Doe" would keep the
          name for good, and so would a message-body column added to a consent or DNC row, or to
          U8's spend tables.
      - **Outside the erasure record, a retained table that holds subject data is `anonymize`,
        never `keep`.** A `keep` table has no trigger. `call_usage_events` is the AI answering
        billing ledger (`schema.ts:7057-7070`), naturally `keep` for financial retention, with
        `caller_phone`. While the subject's live call is still running, the job would blank that
        column, and at session end `billing/call-usage-events.ts:73-77` inserts the row with
        `caller_phone`. Nothing would refuse or late-link it, and the phone would stay. And a
        generic scrub that walks only `scrub` and `anonymize` tables would blank no `keep`
        column at all, while the schema test still passed. So:
        - Any non-U7 table with a subject-data column is `scrub` or `anonymize`, and one whose
          rows are retained is `anonymize`, which brings the trigger, the manifest-driven
          blanking and the late-link. The schema test fails on a non-U7 `keep` table with a
          "subject data, blanked" column.
        - A third label, "subject data, retained by law", is allowed only on a pinned list of
          tables: consent, DNC and the DNC audit rows.
        - On U7's own tables, each "subject data, blanked" column names the transition that
          nulls it, such as a target's encrypted key at its terminal transition.
        - The seed-and-erase test generates its seed from the manifest. It puts a sentinel in
          every column classified as subject data, and asserts each is blank once the job
          completes, including after a write that arrives once its blank step has run.
      - The schema test reads `information_schema.columns` for every manifest table, and fails on
        any column the manifest doesn't classify.
      - It also checks each table's trigger against the manifest: the trigger's arguments, or its
        generated function, name exactly the manifest's designated and key columns. A trigger
        configured with the wrong key column fails.
      - The scrub step takes its column list from the manifest, never from a hand-written list.
      - Test: a test-only migration adds a text column to `customers`, and the coverage test fails
        until the column is classified.
    - **The manifest records how each table is scrubbed.** Blanking can break a constraint.
      `tenant_entity_aliases` (`schema.ts:6412-6432`) has `normalized_alias NOT NULL` with
      `CHECK (char_length(normalized_alias) BETWEEN 1 AND 120)`, and a unique index on
      `(tenant_id, entity_kind, normalized_alias) WHERE active = true`. A blank fails the check,
      and a fixed placeholder collides on the index once a second customer in the tenant is
      erased. The alias step would fail every retry, and the name would stay. So:
      - Each `scrub` table names its method: blank the designated columns, or delete the row.
      - `tenant_entity_aliases` rows that name the subject are deleted.
      - The schema test fails on a `blank` table whose designated columns carry a check
        constraint or a unique index.
      - The seed-and-erase test seeds alias rows for two customers erased in the same tenant.
      - **Each designated column declares its scrubbed value.** Many are `NOT NULL`:
        `service_locations.street1` and `postal_code` (`schema.ts:342`, `:346`),
        `message_dispatches.recipient` (`:1101`), `call_me_back_tasks.caller_phone` (`:3892`) and
        `ai_runs.input_snapshot`, a `JSONB NOT NULL` (`:181`). A scrub that writes `NULL` fails
        with `23502` on every retry and rolls back the whole statement, PII included. `''` isn't
        valid `jsonb`. And a trigger whose blank test knew only `NULL` or `''` would see the
        erase's own `'{}'` as a new value and refuse the scrub. So:
        - The manifest declares each designated column's scrubbed value: `NULL` only where the
          column is nullable, `''` for `NOT NULL` text, and `'{}'` or `'[]'` for `NOT NULL`
          `jsonb`.
        - The scrub writes that value, and the trigger treats exactly `NULL` or that value as
          blank.
        - The schema test fails on a `NOT NULL` designated column whose declared value is `NULL`
          or doesn't cast to the column's type.
      - **A delete names every foreign key that points at the row.** A `files` row the erase
        deletes can still be referenced. `job_photos.file_id` (`schema.ts:1731`) and
        `attachments.file_id` (`:4038`) are `NOT NULL REFERENCES files(id)` with no `ON DELETE`
        action. `voice_recordings.file_id` (`:153`, made nullable by
        `088_fix_schema_constraints`, `:2427-2431`) and `messages.file_id` (`:136`) are nullable,
        with no action either. A call recording's `files` row is keyed by the Call SID
        (`voice/voice-service.ts:608-624`), a tombstone key, while its `voice_recordings` row is
        kept with only its transcript blanked. Deleting the `files` row first would fail with
        `23503`, roll back the `erasure_storage_cleanup` insert in the same transaction, and do
        so on every retry. The step would end `incomplete` for good, and an attachment's `files`
        row would keep a `filename` such as `Jane_Doe_passport.jpg`. So:
        - The manifest lists, for every delete-method table, each foreign key that references
          it, read from `pg_constraint`, and how it is handled:
          - When the erase also deletes the referencing row, that row is deleted first, in the
            same transaction, in child-first order taken from `pg_constraint`.
          - When the referencing row is kept and its link is nullable, the link is nulled in
            that transaction, before the delete.
          - When the referencing row is kept and its link is `NOT NULL`, the parent row can't be
            deleted. A `files` row referenced that way is blanked instead: `filename` and
            `s3_key` take their declared scrubbed values, the key is kept, encrypted, only on the
            cleanup row, and the S3 object is still deleted.
        - The schema test fails on a delete-method table referenced by a `NOT NULL` foreign key
          from a table whose method keeps its rows, unless the delete-method table declares that
          blank fallback, as `files` does.
        - The seed-and-erase test seeds a call recording, a job photo and an attachment for the
          subject. Each `files` row is deleted or blanked, each S3 object is gone, and no step
          fails with `23503`.
    - Free-text stores that can hold a customer's details without a foreign key (notes, messages,
      transcripts, `ai_runs`) are listed in the manifest explicitly, with how each is matched. The
      `jsonb`, `json` and free `text` rule above is the test behind that list.
  - **Fence writers that are still in flight, or the erase can be undone.** An erase can overlap an
    asynchronous writer. For example, the gateway creates a pending `ai_runs` row before it
    dispatches, and only writes `outputSnapshot` after completion (`gateway.ts:568-588`, `:679`);
    the trace export, transcript append and session summary work the same way. A completion that
    lands after the scrub would put the data back.
    - The erase first writes a durable, tenant-scoped erasure tombstone. It is keyed by:
      - the customer id, and the collected session, call and correlation ids
      - **every owned-entity id that other rows link by**: the jobs, estimates, invoices,
        payments, appointments and service locations in the manifest's transitive closure,
        collected in phase 1. Phase 2 severs or anonymizes the parent links, so a child row such as
        `invoice_line_items`, which carries only `invoice_id` (`schema.ts:653-664`), could no
        longer be traced to the subject. Its `invoice_id` still matches the tombstone. A leaf
        row's own id is added only where it becomes the row's only key (see "Phase 1 is sized
        by its fence keys" below).
      - the subject's normalized phone numbers and email addresses, stored as keyed hashes
        (HMAC-SHA256 with a server-side key, recorded by key id and normalization version, see
        "A recipient hash records its key, and a key a hash uses is never retired" below), so the tombstone keeps no raw identifier
      A writer that knows only a recipient, with no customer id, still matches. The erased
      customer row no longer holds the identifiers, so without this such a writer could never
      match the tombstone.
    - **A recipient hash records its key, and a key a hash uses is never retired.** The raw
      identifiers are deleted once the job finishes, so an existing hash can't be regenerated
      under a new key. If the key were rotated, or the normalization changed, a recipient-only
      write would hash differently from every existing permanent tombstone, match none, and
      reintroduce or export an erased customer's data. So:
      - Every row that stores a recipient hash records `hash_key_id` and `norm_version` beside it:
        the tombstone's recipient-hash rows, the write-ahead dispatch rows and the S3 target hash.
        Key material stays in the server's secret store, under its id. A table of key ids with no
        material is the database's record of which ids exist, and every column above references it
        with `ON DELETE RESTRICT`.
      - New hashes use the current key id and normalization version. The matcher, and the stripe
        choice of a send with no customer id, take the candidate set: the identifier normalized
        under each `norm_version` and hashed under each `hash_key_id` that any stored hash still
        uses, plus the current pair. It is normally one or two pairs. A write matches when any
        candidate agrees. It takes the stripes of every candidate in ascending order, which
        includes the stripe of whatever pair phase 1 used.
      - **Rotation adds a key and never removes one that is referenced.** It is an operator step
        that adds the new id and material and makes it current. The old key stays verify-only for
        as long as any row references it, which for a permanent tombstone is indefinitely. Retiring
        an id that a row references is refused by the foreign key, and the retire path reports
        which table holds the reference. The same holds for a normalization change: the new
        version is added, and the old one stays in the candidate set.
      - **A missing key fails closed.** A boot check loads the material for every referenced key
        id. If one can't be loaded, the write paths that need the recipient-hash probe refuse with
        the typed erasure-unavailable error, never proceed unmatched, and `alertOperator` fires.
        Writes keyed by customer id or another non-hash key are unaffected.
      - Tests: a tombstone is made under key `k1`, the key is rotated to `k2`, and a recipient-only
        write of the same phone and the same email is still refused. The same holds after a change
        of `norm_version`. A boot with a referenced key's material missing refuses recipient-only
        writes and alerts, and a write by customer id still goes through. Retiring `k1` while a
        tombstone references it is refused, and retiring it once nothing does succeeds. A new
        tombstone under `k2` matches a dispatch row hashed under `k1`.
    - **Each tombstone row names its job and its key kind.** Two customers in one tenant can share
      a household phone. A flat key set, unique on `(tenant_id, key)`, would fail the second
      customer's phase 1 with `23505` on every attempt, so that customer could never be erased. A
      flat set also can't say which job a match belongs to, which a late target and a late-link
      inbox row both need, and it can't keep one job's exemption from lifting another job's fence.
      So:
      - A tombstone row is `(tenant_id, job_id, key_kind, key)`, unique on all four. Every add, in
        phase 1, the late-link trigger and the lead step, uses `ON CONFLICT DO NOTHING`.
      - The `(tenant_id, key)` probe index isn't unique.
      - `key_kind` separates fence keys (customer, owned entity, session, call, correlation,
        recipient hash, recorded source) from exemptions (see "A held send has a durable release
        path" below).
      - A write is fenced by every job that holds a matching fence key, under the provenance rule
        below. An exemption lifts only the hold of the job that recorded it, and never overrides
        another job's fence.
      - A match adds its late target, or its late-link inbox row, to every job that holds the
        matched key.
      - Test: two customers in one tenant who share a phone are both erased, and both jobs
        complete. A released send's source then sends. A later erase that records that same
        source refuses it.
    - **One fence for every writer, enforced by a test, not by a list.** The writers named in this
      plan are examples, and a list can always miss one. U7 adds a single primitive,
      `withErasureFence(tenantId, sinkId, subjectKeys, write)`:
      - `sinkId` names the writer's `externalSinks` entry (see the structural test below), which
        holds its worst-case duration and its reconciliation read.
      - **The entry also declares the key kinds its writer must pass**, such as a customer id, or
        a recipient hash plus a source row id. `withErasureFence` throws when the key set is empty
        or lacks a declared kind. A calendar sync whose lookup returned null, or a customerless
        send that passes only its job id, would otherwise lock no stripe the tombstone holds and
        match no key. A missing key is an error, never an unfenced write. A unit test covers
        each entry, and a fixture with an empty key set throws.
      - It takes the subject's erasure lock in shared mode, checks the tombstone, and records a
        write-ahead claim, all in one transaction.
      - **The tombstone probe is its own statement, issued after the one that took the
        stripes.** Under `READ COMMITTED` a statement's snapshot is taken when the statement
        starts, not when a lock inside it is granted. Suppose a claim is written as one round
        trip, `WITH l AS (SELECT pg_advisory_xact_lock_shared(…)) INSERT … WHERE NOT EXISTS
        (<tombstone probe>)`, and it starts while phase 1 holds the stripe in exclusive mode. It
        waits, is granted the stripe once phase 1 commits, and still evaluates its `NOT EXISTS`
        against the snapshot from before the wait. It sees no tombstone and inserts a `claimed`
        row that phase 1's claim fence never saw, so the send goes out to the erased subject.
        So:
        - In `withErasureFence`, the senders' claim transaction, the release re-fence and the
          `BEFORE` trigger, the statement that takes the stripes runs first. The probe, and any
          write that depends on it, run in a later statement.
        - Each fence and late-link trigger function is `plpgsql` and `VOLATILE`, so each
          statement inside it takes a fresh snapshot. A `STABLE` function would reuse its
          caller's.
        - The catalog test asserts `provolatile = 'v'` on every fence and late-link trigger
          function.
        - Docker-gated test: phase 1 holds the stripes while a sender and a trigger-bearing
          insert each queue for the shared stripe. Phase 1 commits, and both see the tombstone:
          the send is refused, and the content is dropped.
      - It runs the write, or the provider call, only after the guarded claim flip
        `claimed → sending` (see below). Every sink uses that same flip, whatever table holds its
        claims, so phase 1's fence of `claimed` claims stops every sink alike.
      - **The lock covers every key the tombstone holds, not only the customer id.** Many writers
        can name the subject only by the key they carry, such as `invoice_line_items.invoice_id` or
        a transcript turn's session id. A lock on the customer id alone doesn't serialize them with
        phase 1. So:
        - The erasure lock is keyed like the tombstone probe, by `(tenant_id, key)`, hashed onto a
          fixed number of lock stripes per tenant, so phase 1 takes a bounded number of locks.
        - **Stripes and the spend lock have key spaces of their own.** The app takes most
          advisory locks as `pg_advisory_xact_lock(hashtext($1))` (`jobs/pg-job.ts:138`,
          `invoices/payment-mode-change.ts:171`), whose keys are `int4`, and `app.ts:2603`
          already records one silent collision (590014). With 10,000 tenants at, say, 64 stripes
          each, plus 10,000 spend keys, about 1.5 collisions between a spend key and a stripe are
          expected. Tenant B's phase 1 would then hold tenant A's spend lock in exclusive mode,
          and a B transaction holding that stripe in shared mode would make every reserve and
          settle in A wait. So:
          - Stripes and the spend lock use the two-key form, `pg_advisory_xact_lock(int4,
            int4)`, with one fixed class id for erasure stripes and another for the spend lock.
            The object id is `hashtext` of the tenant and stripe, or of the tenant. Postgres
            keeps the one-key and two-key spaces apart, so no one-key lock can collide with them.
          - The existing two-key locks (`proposals/execution/idempotency-lock.ts:65`,
            `db/tenant-transaction.ts:112`, `db/migrate.ts:51` and the trigger at
            `db/schema.ts:8683`) take their first key from a hash, so a collision with a fixed
            class needs both halves to match.
          - Ascending stripe order means ascending object id, so two tenants whose stripes
            collide still lock in one order.
          - A unit test pins the two class ids as distinct constants, and a structural test
            fails on either literal outside the stripe helper and the spend module.
        - **Phase 1 queues for its stripes, inside a budget, so writers can't starve it.** A
          try-lock that rolls back whenever any stripe is busy may never find every stripe free at
          once: not in a tenant with steady transcript writes, and not behind one long batch
          transaction. Every erase request would then fail. So:
          - Phase 1 collects the subject's keys and takes their stripes in exclusive mode, in
            ascending stripe order, with a blocking `pg_advisory_xact_lock`. A waiting request
            keeps its place in the lock queue, so shared requests that arrive after it wait behind
            it.
          - **The budget is a wall-clock deadline, not a sum of waits.** A budget that counts only
            lock waits leaves out the re-collection and the round trips between locks. With a
            900 ms budget, a re-collection that runs for 650 ms under the locks still leaves the
            next wait its full 900 ms, and a writer that began waiting on phase 1 early in that
            re-collection reaches its deadlock check first. So:
            - The deadline is fixed when phase 1 is granted its first stripe, since no writer can
              wait on phase 1 before then. The first lock's own wait is bounded by the budget.
            - Before each lock, phase 1 sets `lock_timeout` to the deadline minus
              `clock_timestamp()`, through `set_config('lock_timeout', …, true)`. Every later
              statement, the collections and the claim fence included, runs under a
              `statement_timeout` set the same way, so work that isn't a lock wait counts too.
            - When no time is left, phase 1 rolls back and retries, as on a timeout. It never sets
              either timeout to 0, which would turn it off.
            - The deadline minus the first grant stays below the server's `deadlock_timeout` (1s
              by default), less a margin.
          - **Phase 1 collects to a fixed point, not twice.** One re-collection misses a row
            created under an entity that the re-collection itself found. Between phase 1's first
            collection and its locks, a booking flow commits a new job J for the customer. The
            second collection finds J. Before phase 1 asks for J's stripe, the flow's next
            transaction inserts appointment A under J, holding J's stripe in shared mode, and A is
            still uncommitted when the second collection runs. Phase 1 then waits for J's stripe
            and writes the tombstone without A. Rows keyed only by A, such as
            `technician_location_pings` (`schema.ts:989-993`, GPS at the customer's address) and
            `delay_notice_state` (`schema.ts:5345-5348`), then pass the trigger for good. So:
            - Phase 1 repeats collect-then-lock. It stops when a collection, run while phase 1
              holds the stripe of every key found so far, finds no key whose stripe it does not
              hold.
            - That last collection's keys are the ones phase 1 writes into the tombstone.
            - All rounds share the one deadline. The loop always ends, because each round adds at
              least one stripe and a tenant has a fixed number of them.
            - **Every round keeps one total order across concurrent erases.** Sorting only a
              round's new stripes doesn't. Erase A can hold stripe 10 and then discover stripe 5
              while erase B holds 5 and discovers 10, and each waits on the other until the
              deadline, so the endpoint returns `409` with capacity to spare. So:
              - A round whose new stripes are all higher than every stripe phase 1 holds takes
                them in ascending order and goes on.
              - A round that discovers any stripe lower than the highest one held rolls the
                phase-1 transaction back, which releases everything. It restarts with the union of
                all stripes found so far, taken in ascending order from the start, and collects
                again.
              - The set only grows and a tenant has a fixed number of stripes, so restarts are
                bounded. After a small fixed number of restarts, phase 1 takes the tenant's
                complete stripe set in ascending order instead. That blocks every writer in the
                tenant for the length of phase 1, which is why it is the last resort.
              - Each restart is counted and logged. It is a new transaction, so its deadline is
                fixed at its own first grant, and it does not count toward the `409` retry limit
                below.
              - So every phase 1, and `withErasureFence`, which takes all its stripes at once,
                acquire in one ascending order. The `BEFORE` triggers take stripes row by row in
                write order, so they aren't in that order, and the deadline and the `40P01`
                retry below cover them.
            - Tests, Docker-gated: two concurrent erases in one tenant whose discoveries cross (A
              holds stripe 10 and then finds 5, B holds 5 and then finds 10) both complete, with no
              `40P01` and no `409`. A restart is counted and logged. With the restart limit
              exceeded, phase 1 takes the tenant's complete stripe set, and a spy on the lock
              calls sees every acquisition in ascending order.
          - **Why the deadline is below `deadlock_timeout`.** A writer can hold one shared stripe
            while it waits for another that phase 1 holds, because the trigger takes stripes row by
            row, in the order the writes happen. If phase 1 then waits for the writer's stripe, the
            two are deadlocked. Postgres checks a lock wait for deadlock once, `deadlock_timeout`
            after that wait began, and the backend whose check finds the cycle is aborted. That
            could be the writer, such as a live call's transcript append. Any wait on a stripe
            phase 1 holds began after phase 1's first grant, so its check comes after phase 1's
            deadline. So phase 1 gives up first: it rolls back, releases every stripe, and the
            writer goes on.
          - **A writer that was already waiting on another writer can still be the one aborted.**
            Writer W2 holds a session stripe in shared mode and has waited 700 ms on a
            `voice_sessions` row lock held by W1 when phase 1 starts. Phase 1 takes stripe s_a and
            waits on W2's stripe. W1 then asks for s_a, for the customer key it writes next. That
            closes a cycle, W2 → W1 → phase 1 → W2. W2's check fires 300 ms later, inside phase
            1's deadline, and Postgres aborts W2. No timeout on phase 1 can rule that out. So
            `withErasureFence`, and the trigger-bearing write paths on a live call (the transcript
            append, the session summary and status updates), retry their transaction once on
            SQLSTATE `40P01`.
          - When the budget runs out, phase 1 rolls back and retries after a short backoff, a fixed
            number of times. Then the endpoint returns a typed `409`: the erase didn't start, and
            the owner can try again.
          - **Repeated failures to start alert, though no job exists.** With no job row there is
            no sweep, age alarm or `erase_incomplete` alert. So each `409` increments a
            per-customer count in a small U7 table of its own (`tenant_id`, `customer_id`, the
            count and an alert outbox pair), in its own transaction. At a fixed count it marks an
            operator alert due, sent and stamped like the close's alert. The inbox mover does the
            same per inbox row: a fixed number of timeouts on one row marks its alert due, as
            the inbox-age alert does.
        - **Phase 1 stays short, because writers on its stripes wait while it runs.** It writes the
          tombstone, the job row, its encrypted identifiers, the step rows and the queue wake,
          and fences the subject's `claimed` and `released` write-ahead claims in every sink's
          claims table (see
          "phase 1 fences every sink's claims" below). The snapshot of targets is a job step, not
          part of phase 1 (see "Every target the later steps need" above).
        - **Phase 1 is sized by its fence keys, not by the history behind them.** A customer of
          three years can have 150 jobs, 400 appointments, about 16,000
          `technician_location_pings` keyed by appointment, about 4,000 `call_transcript_turns`
          and 1,500 `invoice_line_items`. If every row of the closure went into the tombstone,
          phase 1 would collect about 23,000 rows at least twice and insert them, under
          exclusive stripes and a sub-second deadline. Every attempt would time out, every retry
          would get the `409`, and no job would exist to alert. So:
          - Phase 1 collects and writes only the fence keys: the customer id, the recipient
            hashes, and the ids that other rows link by (jobs, estimates, invoices, payments,
            appointments, service locations, sessions, calls and correlation ids). A leaf row
            such as a location ping or a transcript turn is fenced by its link column, which
            matches one of those keys.
          - A row's own id goes into the tombstone only where it becomes the row's only key: a
            row whose link the erase nulls (`null-link`), or a recorded source. The step that
            nulls the link adds the id in the same transaction, under that id's stripe in
            exclusive mode and phase 1's deadline rules, as the lead step does (see "Recording a
            source in phase 2 is a limit change" below).
          - `snapshot` collects the per-row targets in batched checkpoints (see "Every target the
            later steps need" above), and the re-open triggers touch the job row once per
            statement (see "The re-open triggers are statement-level" above).
          - Docker-gated test: for a subject with thousands of appointments, location pings and
            transcript turns, phase 1 commits inside its deadline, and every one of those rows is
            erased.
        - Every writer and every trigger takes the stripe of each key it checks, in shared mode.
          `withErasureFence` takes all of its stripes at once, in ascending order. An unrelated key
          that shares a stripe only makes its writer wait out a short phase 1.
        - **One lock order with U8: the stripes first, the spend lock last.** No transaction takes
          a stripe while it holds U8's per-tenant spend lock. Phase 1 and the erasure steps never
          take the spend lock. U8 states the same rule. So an erase can make an AI write wait only
          at its stripe, never while that write holds the spend lock, and it never holds up the
          tenant's other reserves and settles, live calls included. U8 checks this order at
          runtime (see U8's "The order is checked at runtime").
      Every writer that can persist or export the subject's data goes through it. That includes:
      - AI content: the `ai_runs` completion, the trace export, the transcript append, the summary
        and the knowledge-chunk ingest
      - outbound messages, email and calls
      - business-integration creates: QuickBooks `ensureCustomerExternalId`
        (`integrations/accounting/sync-service.ts:280-310`) and Stripe saved-card customer
        creation (`payments/stripe-saved-card.ts:84-124`)
      **The structural test enumerates every outbound call, not a list of known clients.** A
      closed list missed two existing writers:
      - `financing/financing.ts:133-145` sends the customer's name, email and phone to Wisetack
        before it saves the local application.
      - `integrations/calendar-sync.ts:132-179` creates a Google Calendar event with the customer's
        name and address before it saves the external event id.
      So:
      - **The test checks each call site, not each file.** A registry of files would let a second
        `fetch` or SDK write, added to a file that is already registered, skip the fence while the
        test still passes.
      - The test parses `packages/api/src` with the TypeScript compiler API and its type checker
        (`typescript` is already a dev dependency, `packages/api/package.json:92`).
      - **A call site is defined by the type of the value being called, not by the symbol it
        names.** Most outbound calls here go through an injected value, wherever it flowed (a
        property, a parameter or a return value):
        - `notifications/twilio-delivery-provider.ts` calls `sms.fetchImpl(...)` and
          `email.fetchImpl(...)` (`:265`, `:361`), a property filled by
          `config.sms.fetchImpl ?? fetch` (`:193`, `:206`). A scan that resolves symbols sees
          only the `?? fetch` default, so a new `sendMms()` calling `sms.fetchImpl(...)` with no
          fence would need no marker.
        - QuickBooks calls `fetchFn` (`integrations/accounting/quickbooks-client.ts:42`), Stripe
          casts `globalThis.fetch as unknown as StripeFetch` (`payments/stripe-saved-card.ts:206`),
          and `shared/timed-fetch.ts:36` calls `(baseFetch ?? globalThis.fetch)`.
        - Langfuse is loaded with `require('langfuse') as LangfuseModule` and called through the
          local `LangfuseClientLike` interface (`ai/gateway/trace-exporter.ts:104-129`), so it
          resolves to no SDK method at all.
        So a call site is any call whose callee or receiver is one of these:
        - a value with the global `fetch`'s type
        - a value whose type a provider SDK package declares, such as `twilio`, `openai`,
          `langfuse` or `posthog-node`
        - a value of a registered provider-surface type, such as `LangfuseClientLike`,
          `StripeFetch`, `TwilioA2pClient` or `TwilioProvisioningClient`
        - a provider write method: `generateUploadUrl` or `putObject` on `StorageProvider`, or a
          wrapper registered as `via` (below)
        - **a transport value**: the global `WebSocket` type, `ws`'s types, and `request`,
          `connect` and `send` on the Node built-ins `http`, `https`, `http2`, `net`, `tls` and
          `dgram`. `ai/tts/elevenlabs-stream.ts:119-121` and
          `voice/transcription-providers.ts:580-582` build their client as `globalThis.WebSocket
          ?? (NodeWebSocket as unknown as typeof globalThis.WebSocket)`, then `send` the TTS text
          or the caller's audio (`elevenlabs-stream.ts:201`, `transcription-providers.ts:745`).
          That value has neither `fetch`'s type nor an SDK type, so without this rule both
          streams pass with no marker.
        A reference that isn't a direct call, such as `fetch` assigned to a variable or passed as a
        value, counts too, so an alias can't hide a call.
      - **The test also fails on whatever can hide that type**, naming file and line:
        - a cast (`as`, or `as unknown as`) of `fetch`, an SDK value or a transport value to a
          type that is neither a transport type nor a registered provider-surface type
        - a `require()` or dynamic `import()` of a provider package whose result isn't typed by a
          registered provider-surface type
        - an `any`-typed callee in a file that references `fetch`, a provider package or a
          provider-surface type
      - **Each call site is covered in one of two ways.** Otherwise the test fails, naming its file
        and line.
        - **Fenced:** it sits inside the `write` callback of a `withErasureFence` call, and it
          resolves to the entry the call's `sinkId` names. Every fence call's `sinkId`, whether or
          not the call wraps a network call, must be a string literal that names a subject-data
          entry in `externalSinks`.
          - **One callback reaches one sink.** A booking flow could wrap a Google Calendar insert
            and the confirmation SMS in one `withErasureFence(t, 'twilio_sms', …)`. The calendar
            insert would then have no claim of its own and no read-back for a lost response, and
            the SMS sink's short `deadline_at` could abort it mid-flight. So each `externalSinks`
            entry declares the call sites it covers: its SDK, surface or transport types, its
            `via` wrappers, or a marker on a bare `fetch`. The test resolves every call site
            inside a fence callback to its entry, and fails unless that entry is the fence's
            `sinkId`. A bare `fetch` inside a callback needs a `// external-sink: <id>` marker
            naming the same sink, and a callback that reaches two sinks fails.
          - **"Fenced" means bounded by the callback, not only written inside it.** A call
            site that drops the callback's `AbortSignal`, such as a call-site
            `withRetry(() => client.create(params), 4)`, keeps retrying past `deadline_at`. A
            `void client.create(...)` lets the callback return before the call lands, and
            passes `no-floating-promises`, whose `ignoreVoid` option is on by default
            (`eslint.config.mjs:66`). Either way the Stripe listing or the QuickBooks queries
            run after `deadline_at`, find nothing and record the target done, and then the
            create lands with the subject's name and email. So:
            - The scan requires every fenced call site to receive the callback's `signal`, or a
              signal derived from it with `AbortSignal.any`, among its arguments or options. A
              `via` wrapper must take a signal parameter and pass it to its marked call.
            - It fails on a fenced call site whose promise isn't awaited or returned on the
              callback's own path: `void`-ed, unawaited, or inside a nested function handed to
              `setTimeout`, `forEach` or a queue.
            - A sink whose SDK can't take a signal declares that. Its entry sets the SDK's own
              timeout and retry options to literal values, which the test checks against the
              entry's declared duration.
            - Fixtures: a fenced call that drops the signal fails, and so does a `void`-ed one.
        - **Registered:** the line above it carries `// external-sink: <id>`, and `<id>` is an
          `externalSinks` entry with a reason. One id covers one call site, so a new call in a
          registered file needs its own entry.
      - A registered entry is one of five kinds: `exempt`, `erasure_cleanup`,
        `erasure_record`, `no_subject_data` and `via`.
        - `exempt`, with a reason, for example a model provider receiving only already-fenced
          content. Its manifest retention entry says what the provider keeps anyway (see "Copies a
          provider keeps anyway" above). The ElevenLabs and Deepgram streams are registered this
          way.
          - **`exempt` is not a free-text allowlist.** Otherwise a new Twilio Lookup or SMS path
            marked `exempt` "read only" would need no fence, no claim and no reservation, and only
            a reviewer reading the registry diff would notice. So `exempt` is allowed only for a
            call site whose resolved provider is on a fixed list of content-only model,
            transcription and speech providers, never a messaging, payment, storage, calendar or
            accounting surface.
          - The set of `exempt` ids, and U8's `spend_exempt` ids, is pinned in a snapshot inside
            the test, so adding one changes a reviewed test file. The repo has no `CODEOWNERS`
            yet, so U7 adds one that names an owner for that file. GitHub enforces `CODEOWNERS`
            only when branch protection requires code-owner review, so this needs an owner
            action: turn on "Require review from Code Owners" for `main`.
        - **`erasure_cleanup`, `erasure_record` and `no_subject_data` are three more kinds, each
          constrained by surface.** `TwilioA2pClient`
          (`integrations/twilio/a2p-10dlc/twilio-a2p-client.ts:77`) and `TwilioProvisioningClient`
          (`notifications/twilio-provisioning.ts:13`) are provider-surface types, so every call
          on them is a call site, yet they carry no
          subject, and `withErasureFence` throws on an empty key set. The erase's own Twilio,
          Stripe and S3 deletes and the QuickBooks anonymize can't be fenced either, because the
          tombstone would refuse them. Left undefined, an implementer would add a third kind as
          one more entry with a reason, and a later WhatsApp send registered "no subject data:
          system notice" would skip the fence, the write-ahead claim and phase 1's claim fence,
          and reach the erased subject with nothing to target it. So:
          - `erasure_cleanup` is allowed only for a call site inside the erasure module whose
            resolved surface method is a delete, a list, a get or the declared anonymize update,
            never a create.
          - `erasure_record` is allowed only for a `putObject` inside the erasure module whose
            bucket is the dedicated erase-record bucket (see "The record is the job's first
            step" above). That PUT is a create, which `erasure_cleanup` forbids, and it can't be
            fenced, since its own customer key is in the tombstone.
          - `no_subject_data` is allowed only for a call site whose resolved surface type is on
            a fixed list, such as A2P registration and number provisioning, never a message,
            call or email create, a customer create, a calendar insert or a storage write.
          - All three id sets sit in the same pinned snapshot as `exempt`.
          - Fixtures: an SMS create marked `no_subject_data` fails, an erasure-module delete
            passes, an erasure-module create fails, and an `erasure_record` `putObject` to any
            other bucket fails.
        - `via`, for a low-level client call that a wrapper reaches, such as the `fetch` inside a
          delivery provider's send method. The entry names that wrapper method as its callers reach
          it, which is the interface method when they hold the interface. The test then treats
          every call of that wrapper as a call site in its own right. The coverage moves to the
          caller, where the subject is known.
        - **A `via` entry is checked, not trusted.** The marker records what its author believed
          about the call graph. Suppose the `fetch` sits in a private `post()` helper marked
          `via: DeliveryProvider.send`, and a developer later adds `sendBulk()`, which calls
          `post()` directly. The calls of `sendBulk` would reach the same `fetch` with nothing
          checking them. So a `via` entry is valid only when every route to the marked call goes
          through the named wrapper. The test walks the references of the marked call's enclosing
          function with the type checker's reference search. Every reference must be
          inside the named wrapper, inside a `withErasureFence` callback, or itself a registered
          `via`. Any other route fails the test, naming file and line.
      - Every subject-data entry has a manifest entry with its delete or retention rule.
      - An entry that no fence call or marker names fails the test too, so stale coverage can't
        linger.
      - The test also fails on a runtime dependency in `packages/api/package.json` that it doesn't
        list as a provider SDK, as a transport (`ws`), or as neither. A new SDK or transport can't
        arrive unseen.
      - Wisetack and Google Calendar join the fence and the external-sink manifest:
        - **Ambiguous creates.** The create sends `external_reference: <tenant>:<applicationId>`
          (`financing/financing-provider.ts:92-111`), which Wisetack echoes on its webhook. That
          echo links a financing create whose response was lost, as `custom_args` does for
          email. The plan names no Wisetack lookup endpoint, so there is no read-back (see
          "Wisetack is linked by its webhook" below).
        - **Calendar events are found by the appointment id we stamp, not by a stored event id.**
          `pushForTechnician` inserts a new event on every push
          (`integrations/calendar-sync.ts:112`). `appointment_calendar_events` keeps only the
          latest id: the upsert overwrites it (`:322`), and a failed push overwrites a good id with
          null (`:195`). Once appointment sync is
          wired (today only test-push calls it, `routes/calendar-integrations.ts:361`), a
          reschedule or a retry after a lost response leaves earlier events with the customer's
          name and address that no stored id names. A deterministic event id doesn't help: Google
          requires event ids to be unique per calendar, and an insert with an existing id, a
          deleted event's included, returns 409, so every re-push would fail. So:
          - Every insert already stamps `extendedProperties.private.serviceos_appointment_id`
            (`:148`), and each calendar claim records the Google account and the concrete
            calendar it inserted into (see "Google Calendar: the Google account and the concrete
            calendar" above).
          - The calendar step lists
            `events.list?privateExtendedProperty=serviceos_appointment_id%3D<id>` for each subject
            appointment, on each calendar that a calendar claim or an `appointment_calendar_events`
            row names for it, with that account's credentials, and deletes every match.
          - That listing is also the read-back for a lost create, and it finds events whose ids
            were overwritten.
          - Test: an appointment pushed twice, whose first event id was overwritten, has both
            events deleted.
        - **On erase.** The erase deletes the subject's calendar events. For financing, which the
          lender holds under its own obligations, it records what the provider keeps and says so in
          the result.
    - **Local writes are fenced in the database, so no repository can skip the fence.** A test over
      provider calls can't see a local write. For example, a transcription already waiting on its
      provider still runs `voiceRepository.updateStatus(..., 'completed', { transcript, metadata })`
      (`workers/transcription.ts:489-508`) after the scrub. That would put the transcript back, and
      the encrypted raw copy in `metadata.raw_transcript_retention` with it. So:
      - Every table that the erase-coverage manifest classifies `scrub` or `anonymize` gets a
        `BEFORE INSERT OR UPDATE` trigger.
      - The trigger takes the shared stripe lock of each subject key it checks, so it serializes
        with phase 1 like every other writer. It probes the tombstone in a later statement than
        the one that took the stripes (see "The tombstone probe is its own statement" above).
      - It checks the row's subject keys against the tombstone. The manifest maps those keys for
        each table: `customer_id`, session id, call SID or correlation id, or, for a transitively
        linked table, the owned-entity link column, such as `invoice_line_items.invoice_id`.
      - **It also probes the row's own primary key.** Every entity other rows link by has its id
        in the tombstone, and so do every row whose link the erase nulls and every recorded
        source (see "Phase 1 is sized by its fence keys" above), but a trigger that probes only
        link columns never looks at them. Lead L was converted into
        customer A. The erase blanks L and nulls `leads.converted_customer_id`. A staff member
        still has L's edit form open and saves it, and `leads/pg-lead.ts:299-303` runs an
        `UPDATE leads` that sets the name, phone, email and notes and never names
        `converted_customer_id`. The only link column is null in `OLD` and `NEW`, so the save
        would pass, no late link would fire, and A's name, phone and email would be back on L
        for good. An unconverted lead or callback task recorded as a source is the same: its
        only tombstone key is its own id. So:
        - The manifest's key mapping lists `id` for every `scrub` or `anonymize` table in the
          closure and for every identifier-linked store. The schema test fails on any such table
          whose mapping leaves `id` out.
        - Test: after the job nulls a converted lead's link and blanks it, a stale lead-form save
          that carries the old name and email is refused. The same holds for an unconverted lead
          recorded as a source.
      - Test: after phase 2 has blanked the subject's `customers` row and the job behind an
        invoice, an in-flight update that writes a description into one of that invoice's
        `invoice_line_items` rows is caught by its `invoice_id`, and the description stays blank.
      - **It stops only writes that would put subject data back, never ordinary updates to retained
        rows.** Retained financial records keep changing after an erase.
        `PgInvoiceRepository.incrementAmountPaidAtomic` and `reconcileBalanceAtomic` still update
        balances and statuses on an erased customer's invoices and payments, and refusing those
        writes would leave legally retained records wrong. So:
        - The manifest lists each table's designated PII/content columns, each with its declared
          scrubbed value (see "Each designated column declares its scrubbed value" above).
        - On a tombstone match, the trigger compares `NEW` with `OLD` only on those columns. A
          write puts data back when it would set a designated column to a value that is neither
          `NULL` nor its scrubbed value, and differs from `OLD`. On an `INSERT`, any designated
          column holding something other than `NULL` or its scrubbed value counts.
        - **In a `scrub` table, such a write raises a dedicated SQLSTATE.**
        - **In an `anonymize` table, the trigger blanks it instead of raising.** It sets `NEW`'s
          designated columns to their scrubbed values and lets the write through. These rows are
          retained records, and a refusal would drop the write's financial part along with its
          content. After an erase, the owner records a check payment against the erased
          customer's retained invoice, with notes "check #4411". `payments.notes` is designated
          and `invoice_id` is a tombstone key, so a refusal would drop the payment, and the
          retained invoice would show a balance that was paid. A stale form that resends an old
          description with a status change is the same. The late-link rule below still applies.
        - Every other write passes: a balance, status or reconciliation update that leaves the
          designated columns as they are, and a write that only blanks them, which is what the erase
          itself does.
        - Test: after an erase, a payment against the customer's retained invoice still updates
          `amount_paid` and the status. A new payment with notes on that invoice commits with
          blank notes and the correct amount. An update that tries to put a description back on
          the same invoice commits with the description still blank.
      - **A write that links new data to the erased subject is caught too.** Between phase 1 and
        the `customers` scrub, the customer's phone is still on its row. A call identified as the
        subject inserts a `voice_sessions` row with `customer_id` set to the subject and no
        content yet, so no designated column is non-blank and the insert passes. Its new session
        id is no tombstone key, so every transcript turn keyed by it passes too, and no step ever
        targets it. The same goes for a new job with an empty description and its appointments.
        So the trigger also checks the row's subject-key columns:
        - An `INSERT` whose subject-key column matches a tombstone key, or an `UPDATE` that changes
          such a column to one, attaches new data to the erased subject.
        - In a `scrub` table, it is refused with the erasure SQLSTATE. A writer that creates a new
          entity, such as the voice path's session insert, then writes it without the subject
          link, so the call goes on as an unknown caller.
        - In a table whose rows the manifest retains (an `anonymize` table, such as a payment on a
          retained invoice), it passes, and the late link below runs.
        - **The late link runs in an `AFTER INSERT OR UPDATE` row trigger, never in the `BEFORE`
          one.** Postgres runs `BEFORE INSERT` row triggers on every proposed row, including one
          that `ON CONFLICT DO NOTHING` then skips, and one that `DO UPDATE` turns into an update
          of an existing row with another id. `payment_refunds` inserts with `ON CONFLICT
          (tenant_id, stripe_refund_id) DO NOTHING` (`invoices/pg-payment.ts:302`), and
          appointments insert with an idempotency key (`appointments/pg-appointment.ts:90`). A
          redelivered refund webhook would add an id that is never inserted to the tombstone, and
          each redelivery would re-open the completed job for a row that doesn't exist. So:
          - The `BEFORE` trigger keeps the stripe locks, the refusal and the blanking of `NEW`.
          - The `AFTER` trigger fires only for the row actually written, which on the `DO UPDATE`
            path is the existing row. In the writing transaction it adds that row's id to the
            tombstone of every job that holds the matched key, and writes a late-link inbox row
            naming it for each of those jobs.
          - Neither trigger updates the job row, so a writer that already holds an invoice row
            can't deadlock with a worker that holds the job row. Their tombstone and inbox
            inserts do take `FOR KEY SHARE` on it through the foreign key, which is why job rows
            are locked `FOR NO KEY UPDATE` (see "Job rows are locked `FOR NO KEY UPDATE`"
            above).
          - A step counts a late target whose row no longer exists as done.
          - Test: a duplicate refund delivery for a retained payment writes no inbox row and no
            tombstone key.
        - **The inbox mover collects what hangs under a late link, under exclusive stripes.**
          After S's phase 1, an office user reassigns job J2 from customer X to S. The trigger
          passes that `jobs` update (`anonymize`, `keep-link`), adds J2 to the tombstone and
          writes an inbox row naming J2. That add is a limit change made without the exclusive
          stripe the design rule requires, so a technician's `job_timeline_events` note keyed by
          J2 can probe the tombstone before the reassignment commits, and pass. And a mover that
          targets only J2 never collects J2's existing appointments, notes and photos, or the
          photos' S3 objects. So the sweep moves inbox rows into their job's steps like this:
          - It runs one transaction per job, never one per tenant, so a failure on one job's
            inbox row can't roll back another job's.
          - It takes the job row first (see "Several job rows lock in ascending id order"
            above), then collects the fence keys under each late-linked id to a fixed point, as
            phase 1 does (see "Phase 1 is sized by its fence keys" above).
          - It takes the stripes of the keys it finds in exclusive mode, under phase 1's deadline
            and `lock_timeout` rules, with the deadline starting when it is granted the job row.
            A timeout rolls back and is a short wait, not a failed attempt, up to the alert
            count in "Repeated failures to start alert" above.
          - It adds every key found to the tombstone, and re-opens `snapshot` with each
            late-linked id as a target. `snapshot` then records the rows under that id as
            targets of their stores' steps in batched checkpoints, so a large late-linked
            closure never has to fit in one transaction. A writer that committed beside the
            trigger is then caught by that collection.
          - It claims any job with an inbox row, whatever its state.
          - Test: a job re-linked to the subject after phase 1, with an existing appointment
            note and photo plus a concurrent timeline note, has all three erased before
            `erase_completed`.
        - Test: an inbound call identified as the subject between phase 1 and the `customers`
          scrub leaves no transcript turns once the job completes. A payment on the retained
          invoice after phase 1 commits, and the job then anonymizes the new payment's link.
      - Writers treat that SQLSTATE as "erased, drop the content". Only a `scrub` table raises
        it. It is never an error that retries. The transcription worker ends that recording's job
        without writing.
      - The manifest schema test reads `pg_trigger` in the Docker-gated suite. It fails when any
        `scrub` or `anonymize` table lacks the trigger, or an `anonymize` table lacks its late-link
        trigger, so a new table or repository is covered by construction.
      - **It checks that each trigger fires, not only that it exists.** Every migration re-runs on
        each boot, so a backfill migration that runs `DISABLE TRIGGER` and never re-enables it
        leaves `tgenabled = 'D'` for good. A trigger created `BEFORE UPDATE` only is listed too.
        So for each fence trigger, each late-link trigger, the `audit_events` trigger and each
        step-target re-open trigger, the test asserts that `tgenabled` is `'O'` or `'A'`, and
        that `tgtype` encodes its level (`ROW` for the fences and the late link, `STATEMENT`
        for the re-open), its timing (`BEFORE` for the fences, `AFTER` for the late link and the
        re-open) and its events (`INSERT` and `UPDATE` for the fences and the late link, one
        each for the two re-open triggers). It also asserts that the runtime role can't set
        `session_replication_role`, which would stop every `'O'` trigger from firing. The
        connection principal can, so the structural test in "'Never lifted' is enforced in the
        database" above fails on any other code that sets it.
      - The tombstone lookup is an index probe on `(tenant_id, key)`, not unique (see "Each
        tombstone row names its job"), so the per-row cost on hot tables such as
        `call_transcript_turns` stays small.
      - Test: a transcription is held at its provider while the erase runs. Its completion write is
        refused by the trigger, the recording's transcript and metadata stay blank, and the job
        doesn't retry.
    - **Presigned uploads are writers too, and they outlive the request.** `/api/files/upload-url`
      creates the `files` row and returns a presigned PUT URL (`routes/files.ts:80-114`), valid for
      `DEFAULT_UPLOAD_EXPIRES_SECONDS` (300s, `files/storage-provider.ts:69`). The client uploads
      the bytes directly to S3 later, so no application writer is in flight to drain. An erase can
      delete the still-empty key and its row, report success, and then the client uploads. That
      leaves a customer object no re-scan can find. So:
      - **Fence every `generateUploadUrl`.** Signing goes through the fence, and after the
        tombstone it is refused for the subject. The call sites are `routes/files.ts`,
        `routes/job-files.ts`, `routes/job-photos.ts`, `routes/attachments.ts`,
        `telephony/recording-webhook.ts` and `telephony/voicemail-status-route.ts`. The structural
        test lists `generateUploadUrl` among the provider write methods, so a new call site has to
        go through the fence too.
      - **Keep issued keys until no upload to them can still be running, durably.** A key held
        only in the running erase is lost if the process restarts before the upload ends, and the
        client could then upload with nothing left to find it. So:
        - In the same transaction that deletes a subject `files` row, or blanks one that a kept
          row still references (see "A delete names every foreign key that points at the row"
          above), the erase inserts an `erasure_storage_cleanup` row with the bucket, the key and
          `not_before`. This happens whether or not the upload went through.
        - **`not_before` is the end of the upload window, not the URL's expiry.** S3 checks a
          presigned URL's expiry when the request starts. A large PUT that starts a second before
          expiry keeps transferring after it, and its object appears only when the PUT finishes. A
          delete and a HEAD at expiry plus clock skew could both run while that PUT is underway.
          So:
          - The signed size bounds the transfer. `generateUploadUrl` requires `sizeBytes` and signs
            it as `Content-Length` (`files/storage-provider.ts:214-231`), so a PUT can't send more
            bytes than the route validated, and never more than `MAX_FILE_SIZE`
            (`files/file-service.ts:113`).
          - Every fenced storage write records the URL's expiry and the signed size on its
            write-ahead claim. That includes `putObject`, which signs its own 60-second URL for the
            body's length (`files/storage-provider.ts:269`).
          - `not_before` is that expiry, plus clock skew, plus a transfer allowance: the signed
            size at a fixed floor throughput, capped at a fixed maximum.
        - The erasure job's S3 step processes those rows after `not_before`: it deletes each key
          again. Each row carries the job id, and the step is `done` only when every row is.
        - Then a HEAD request confirms each key is gone, and only then is the cleanup row marked
          done.
        - **On a versioned bucket a HEAD 404 proves nothing.** Storage is any S3-compatible
          endpoint (`STORAGE_ENDPOINT`, `shared/storage-config.ts`). On a bucket with versioning
          enabled or suspended, a `DeleteObject` without a `VersionId` only adds a delete marker.
          HEAD then returns 404, and `ListObjectsV2` shows nothing, while
          `GetObject?versionId=` still returns the customer's photo. So:
          - A boot-time config guard, like PRIV-6's, reads `GetBucketVersioning`. A delete
            response that carries `x-amz-delete-marker: true` also marks the bucket versioned.
          - **The guard says what an error answer means.** R2, which the `R2_*` variables
            describe (`shared/storage-config.ts:60-68`), has no bucket versioning or replication
            in its S3 API and can answer `GetBucketVersioning` and `GetBucketReplication` (below)
            with `NotImplemented`. A guard that read that as "can't prove unversioned" would stop
            every production boot on R2. One that read every error as "unversioned" would pass an
            endpoint that versions but errors on the call, where a HEAD 404 proves nothing. So:
            - A `NotImplemented` answer from an R2 endpoint (`*.r2.cloudflarestorage.com`, as
              `storage-config.ts:68` builds it) means unversioned and unreplicated.
            - Any other error, or `NotImplemented` from another endpoint, refuses boot in
              production or staging unless an acknowledgement is set (the PRIV-6 shape).
            - Tests cover both against mocks.
          - On a versioned bucket the step lists `ListObjectVersions` with the key as prefix,
            keeps the entries whose key is exactly that key, deletes every version and delete
            marker by `VersionId`, and confirms that the same listing comes back empty. That
            replaces the HEAD.
          - If Object Lock or a bucket lock refuses a delete, the target ends `provider_retained`
            with the lock's retention date.
          - **A replicated bucket's replica is cleaned too.** AWS's "What does Amazon S3
            replicate?" says that a `DELETE` naming a version id deletes that version in the
            source bucket only, and the deletion isn't replicated. Delete markers aren't
            replicated by default either. Replication requires versioning, so the version deletes
            above would leave every version in the replica while the source listing comes back
            empty. So:
            - The boot config guard also reads `GetBucketReplication`.
            - When a rule exists, the S3 step runs the same version deletes and empty-listing
              check in each destination bucket, on that bucket's credentials. A target is done
              only when every bucket is clean.
            - In production or staging the guard refuses a replicated bucket without destination
              credentials, unless an explicit acknowledgement is set (the PRIV-6 shape). With the
              acknowledgement, the target ends `provider_retained`, naming the replica.
            - Test: against a mocked replicated bucket, the replica's versions are deleted, or
              the store reports provider-retained.
          - Test: against a versioned mock bucket, every version of the key is deleted, and a
            `GetObject?versionId=` afterwards finds nothing.
        - Until every cleanup row for the erase is done, the S3 store is `incomplete`. The result
          shows when it expects to finish, which is the latest `not_before` of its rows. A restart
          resumes from the rows.
        - Test: the process restarts between the row delete and the re-delete. The worker still
          removes the late upload.
      - **A late object is caught when it is created, not by the clock.** The transfer allowance is
        an estimate, not a proof. A client can send bytes more slowly than any floor, and the
        storage provider doesn't stop a PUT that started before expiry. So closing a cleanup row
        doesn't end the check:
        - When the key is nulled, the cleanup row keeps the key's listing prefix: the key cut just
          after its file id, such as `<tenant>/<file id>/` (`files/file-service.ts:194`) or
          `…/<file id>-` (`routes/attachments.ts:136`). The prefix names no file, so the erase
          record still holds no subject data. A key with no filename in it, such as a recording key
          (`telephony/recording-webhook.ts:113-119`), is its own prefix. The thumbnail key,
          `${key}.thumb.jpg` (`workers/image-post-process-worker.ts:60-62`), falls under the same
          prefix.
        - **An object-created notification re-opens the job.** The deploy can point at AWS S3 or
          Cloudflare R2 (`shared/storage-config.ts:12-13`). Both can send the bucket's
          object-created events to a queue, which a worker drains (P0-009). For each created key,
          the worker:
          - decodes the key first. S3 sends `s3.object.key` URL-encoded, so the worker
            form-decodes it: `+` to a space, then percent-decoding. `sanitizeFilename` keeps
            spaces (`files/file-service.ts:136-143`), so `Jane Doe passport.jpg` arrives as
            `Jane+Doe+passport.jpg`. A delete of the encoded key returns 204 for an object that
            doesn't exist, and its HEAD returns 404, so the real object would stay. The match, the
            delete and the check all use the decoded key. Another provider's notification is
            decoded by its own documented encoding.
          - takes the tenant from the key's first segment, and sets it before it reads or writes
          - looks for that tenant's cleanup row, open or closed, whose prefix starts the key
          - when one matches and no `files` row holds the key, adds the key to that row's job as a
            late target, encrypted, or re-arms its closed target (see "A target that comes back
            re-arms its row" above)
          That re-opens the job under the job row's lock (see "A late target re-opens the job"
          above). The S3 step deletes the object, confirms with a HEAD and nulls the key again,
          however long after the URL's expiry the PUT finished.
        - **A listing backs up a lost notification, and it has no end date.** A notification can be
          delayed, or lost while the queue consumer is down. And the provider checks a presigned
          URL's expiry only when the request starts, so it doesn't bound how long an accepted PUT
          runs. No provider bound is cited here, so no date exists after which a scan could stop
          without risking a PUT that finishes after the last listing and leaves an untracked
          object. So the leader-gated sweep lists each cleanup row's prefix (`ListObjectsV2` with
          that prefix) in two phases, and treats any object it finds the same way as a
          notification:
          - **A frequent phase** on a fixed schedule for a fixed period after the row closes, for
            example daily for 30 days.
          - **Then a low-frequency backstop that doesn't end**, for example weekly, for as long as
            the row exists. The row keeps its prefix, which names no file. It retires the backstop
            only if the deploy's storage endpoint is shown to enforce an upper bound on a PUT's
            duration, and then only after that bound plus a margin.
          - **On a versioned bucket, both phases list versions.** A late PUT can become
            non-current before a pass runs, for example when a lifecycle rule or another delete
            adds a delete marker. `ListObjectsV2` then shows no key while the bytes are still
            readable by version id, so the row would never re-open and the version-aware delete
            (see "On a versioned bucket a HEAD 404 proves nothing" above) would never run. So,
            when the bucket is versioned or suspended:
            - Both phases use `ListObjectVersions` on the row's prefix. Any version or delete
              marker whose key starts with the row's prefix is a hit, and a hit re-opens the job
              the same way. As for a notification, a key that a `files` row holds is not a hit,
              so a sibling file sharing the prefix is left alone.
            - The S3 step then deletes every version and delete marker of the key by `VersionId`
              and confirms with a version listing that comes back empty for it.
            - The bucket's status is the boot guard's `GetBucketVersioning` answer, or a delete
              response carrying `x-amz-delete-marker: true`. It is recorded, and a bucket that was
              ever versioned stays treated as versioned, since suspending versioning keeps its
              existing versions.
            - An unversioned bucket keeps `ListObjectsV2`.
          - **What bounds the cost:** one listing request per prefix per period (a versions
            listing on a versioned bucket), which returns nothing in the normal case. Each row records its next scan time, so the sweep resumes after
            a restart, and each pass takes a fixed budget of due rows. The cost grows with the
            number of erased upload keys, never with the size of the bucket.
        - Every S3 target the step takes from a write-ahead claim, rather than from a deleted
          `files` row, gets a cleanup row too, with `not_before` from that claim. So this check
          covers it as well.
        - **A public URL is purged at the CDN too.** With `STORAGE_PUBLIC_URL` set,
          `generateDownloadUrl` returns a permanent, unauthenticated URL
          (`files/storage-provider.ts:233-236`), for example an R2 custom domain behind
          Cloudflare's cache. A link sent earlier by SMS or email keeps serving the cached photo
          after the origin delete, until the edge TTL runs out, while the origin check already
          reports the key clean. So when a public base URL is configured:
          - The S3 step purges each deleted key's public URL at the CDN (a Cloudflare purge by
            URL, or a CloudFront invalidation).
          - **The CDN confirms the purge, not one GET.** A CloudFront invalidation runs across
            edge locations asynchronously, and `GetInvalidation` reports `InProgress` until
            every edge is done. A GET from the worker reaches only its nearest edge, which can
            return 404 while an edge near the customer still serves the cached photo. So the step
            waits, through a wait checkpoint with a `wait_deadline`, for the CDN's own completion
            signal: `GetInvalidation` returning `Completed` for CloudFront, or for Cloudflare a
            successful purge response plus its documented propagation allowance. An
            unauthenticated GET that returns 404 is then the final check. The S3 store stays
            `incomplete` until then.
          - The boot config guard refuses `STORAGE_PUBLIC_URL` in production or staging without
            purge credentials for that domain, unless an explicit acknowledgement variable says
            the domain isn't cached (the PRIV-6 shape).
        - **What the tenant sees.** The person uploading may see the PUT succeed, because the
          storage provider can't stop a PUT already underway. The file never appears in the app,
          since its `files` row is gone, and the object is deleted, at the CDN as well when there
          is a public URL. The owner's erase result shows
          the S3 store waiting until its latest `not_before`, then done. A late object re-opens the
          job: the owner sees it running again, then completed again, with the late object listed
          as deleted and a new `erase_completed` for that close.
      - Test: an upload URL is issued, the erase runs, and the client PUTs the bytes afterwards,
        before the URL expires. The re-delete removes the object, and the erase reports success
        only after the HEAD check.
      - Tests, against a mocked storage endpoint that can hold a PUT open:
        - A PUT starts one second before its URL expires and is still transferring at expiry plus
          clock skew. The S3 step doesn't run before `not_before`. Once the PUT completes, the
          step deletes the object and the HEAD comes back clean.
        - A PUT held open past `not_before` completes after its cleanup row has closed. Its
          object-created notification re-opens the job, the object is deleted, and the job closes
          again with one `erase_completed` for the new generation. Afterwards no U7 table holds the
          filename.
        - The same late PUT with its notification dropped is found by the next backstop listing
          and deleted.
        - On a versioned bucket, a late PUT is followed by a delete marker before the backstop
          pass. The backstop still finds the non-current version, re-opens the job, deletes every
          version and marker, and the version listing for the key comes back empty. A sibling
          object under the same prefix that a `files` row holds is not a hit and is left alone.
        - A PUT completes after the last frequent listing, with its notification dropped. The
          low-frequency backstop still lists the row's prefix, finds the object, re-opens the job
          and deletes it, and the job closes again. With the clock set years past the frequent
          phase, the row is still scheduled, and no cleanup row retires its backstop without a
          configured provider bound.
        - A notification for another file of the same tenant matches no cleanup row and changes
          nothing.
        - A late object whose filename contains spaces and a literal `+` is matched, deleted and
          checked by its decoded key, and a GET of the real key afterwards finds nothing.
        - With a public base URL and a mocked CDN that caches, the S3 store stays `incomplete`
          until the purge runs and an unauthenticated GET of the public URL returns 404.
    - **A writer the fence refuses can still leave a copy, and so can one in flight at phase 1.**
      Targets come from the `snapshot` step's record of stored SIDs and keys, the status callbacks
      and the upload cleanup rows. Some writers create the external copy before any row records it:
      - The recording and voicemail webhooks fetch the bytes from Twilio and PUT them to S3 before
        they insert `voice_recordings` (`telephony/recording-webhook.ts:391-407`,
        `telephony/voicemail-status-route.ts:533-556`). They delete Twilio's copy only after that
        row commits (`recording-webhook.ts:454`).
      - The image post-process worker writes `thumbnailKeyFor(key)` before it records the
        thumbnail key (`workers/image-post-process-worker.ts:147-156`).
      - Customer MMS intake runs `putObject` before `fileRepo.create`
        (`sms/customer-mms/customer-mms-intake.ts:162-163`).
      For example, a call ends, and the owner erases the customer ten seconds later. `snapshot`
      records the Call SID, but no Recording SID exists locally yet. The recording callback then
      arrives, the fence refuses it, the handler returns `500`, and Twilio gives up after its
      retries. The Twilio calls step deletes the Call, but the Recording with the customer's audio
      stays at Twilio, its SID recorded nowhere, and the job completes. So:
      - **A refusal still registers the external copies.** When the fence refuses a recording or
        voicemail callback, the handler adds the `RecordingSid`, and the deterministic S3 key from
        `buildRecordingStorageKey` or `buildVoicemailStorageKey`, as late targets on every job
        whose tombstone holds the matched key. That re-opens the job (see "A late target re-opens
        the job" above). The handler then returns `200`, since the job now owns the cleanup.
      - **That rule belongs to the sink, not to two handlers.** Every `externalSinks` entry whose
        provider copy can exist before its local row declares so: the recording and voicemail
        webhooks, the Vapi webhook (see "A call that ends after phase 1 is still targeted"
        above), image post-processing and customer MMS. Its handler registers the copy as a late
        target when the fence refuses its local write. The per-registered-sink test sends each
        such sink's callback after phase 1 and asserts that a late target exists.
      - **The Twilio recordings step asks Twilio, not only our rows.** For every subject Call SID it
        lists the Call's recordings at Twilio (`Recordings?CallSid=`) and deletes each one. It runs
        with a `not_before` of the call's completion plus the recording-callback window, and before
        the Twilio calls step deletes the Call.
      - **Every fenced storage write records its key on its write-ahead claim.** That covers
        `putObject` as well as `generateUploadUrl`, and the structural test lists both among the
        provider write methods.
        - The S3 step takes as targets every subject claim's bucket and key, plus
          `thumbnailKeyFor` of every subject key.
        - It waits for `sending` claims to reach a terminal state, up to their deadline (see
          "Every wait has a deadline" above). Then it deletes each key again and confirms with a
          HEAD request, or with the version listing on a versioned bucket. A key from a signed
          URL is also gated by its cleanup row's `not_before` (see "`not_before` is the end of
          the upload window" above).
      - These writers join the drain list below.
      - Tests:
        - A recording callback arrives after phase 1. The handler returns `200`, and the job
          deletes that Recording at Twilio and its S3 key.
        - A webhook is paused between its S3 PUT and its row insert when the erase starts. Its
          insert is refused, and the S3 step still deletes the object.
        - A post-process job is paused before its thumbnail put when the erase starts. Once it
          resumes, the S3 step still deletes the thumbnail, and the HEAD check comes back clean.
    - **A recipient match fences only the subject's own work, by provenance, not by time.** A
      household can share a phone or an email, so a recipient hash alone can't say whose send it
      is, and neither can creation time. So:
      - A send whose source record links to a customer is fenced by that customer's id only. A
        reminder for customer B is never fenced by customer A's recipient hash, even when they
        share a number.
      - When the erase finds an identifier-linked source row that has no customer link (a lead or
        callback task it scrubs, or one it puts on the candidate list), it records that row's id in
        the tombstone.
      - **Recording a source in phase 2 is a limit change, so it is serialized like phase 1.** Only
        the phase-2 lead step finds identifier-linked sources, since it reads the encrypted
        identifiers. Lead L has no customer link, matches customer A only by A's email, and has a
        phone that isn't one of A's. Between phase 1 and the lead step, L's follow-up SMS matches
        no recipient hash and no recorded source, so it goes out, and Twilio stores it. A send
        that is between its claim and its flip when the step records L goes out too, because only
        phase 1 fences claimed rows. Neither message is ever a target. So in one transaction,
        after the job row (see "One lock order: the job row first"), the lead step:
        - takes the stripe of each source id it records, in exclusive mode, under phase 1's
          deadline and `lock_timeout` rules. Senders pass the source row id as a declared key
          kind, so they hold that stripe in shared mode. A timeout rolls back and is a short wait,
          not a failed attempt.
        - records the ids
        - moves every `claimed`, `held` or `released` claim from those sources to `fenced`, in
          every sink's claims table, and deletes a held row's stored message
        - adds each claim from those sources that started after phase 1 (`sending`, `sent` or
          `ambiguous`) as a target of the Twilio messages or email step. That step then deletes
          the SID, or records the send `provider_retained`.
        - Test: a lead matched only by email sends to its own phone between phase 1 and the lead
          step, and a second send is paused between its claim and its flip when L is recorded.
          After the job completes, the first message is deleted at Twilio and the second was
          never sent.
      - A customerless send is refused when its source row is one of those recorded ids.
      - A customerless send that matches the recipient hash but whose source row isn't recorded is
        ambiguous, unless the job whose hash it matched holds an exemption for that source. It is
        held, not refused, and goes onto that job's owner-confirmed candidate list. The
        owner either releases it ("this is someone else") or drops it. Nothing stays held
        indefinitely: a hold nobody decides expires (below).
      - **A claim already committed when phase 1 runs follows the same rule.** Lead L matches
        customer A only by phone. A follow-up SMS to L commits its claim, with no customer and A's
        phone as recipient, just before phase 1, and pauses before its flip. A fence that matches
        `customer_id` never matches its null, so the send would go out after the tombstone, and
        the Twilio messages step, which takes only rows linked to the subject, would never delete
        it. A fence that matches the recipient would instead drop household member B's send.
        Phase 1 can't hold the row either, since it has no rendered message. So:
        - Each write-ahead row also records its source (`source_type`, `source_id`) and the
          recipient's keyed hash, with the key id and normalization version it was made with.
        - Phase 1, which holds those stripes, applies the rule to `claimed` and `released` rows.
          A row whose `customer_id` is the subject, or that has no customer and a source already
          recorded in the tombstone, moves to `fenced`.
        - A row with no customer, a matching recipient hash and a source that isn't recorded is
          added to its step (Twilio messages, or email) as a target. That step runs after the
          identifier-linked lead step has recorded its rows. It waits for the row to be terminal,
          then deletes its SID when its source has since been recorded, or candidate-lists it.
        - Test: a lead-sourced customerless send paused between its claim and its flip during
          phase 1 is never sent, or is deleted at Twilio before `erase_completed`. A household
          member's customerless send claimed at the same time still goes out.
      - **A held send has a durable release path, and an expiry.** Its write-ahead row holds only a
        body hash. Re-running the source would meet the same fence, since the recipient hash still
        matches and the source row still isn't recorded, so a release that re-ran it would be held
        again. So:
        - The held row keeps the rendered message, encrypted with `encrypt`, and a
          `hold_expires_at`. The source sets it to when its message goes stale, such as the
          appointment start for a reminder, capped at a fixed maximum.
        - **A release is checked against every tombstone, not only the one that held it.**
          Customers A and C share household phone P, and lead L has phone P and no customer link.
          L's send R is held under A's erase. If C's erase has since recorded L, a release that
          read only A's tombstone would send R to P after C's erase fenced L. So releasing is one
          owner-only, audited transaction (see "Every owner decision on an erase" above). It takes
          the row's recipient-hash and source stripes in shared mode, and then:
          - refuses the release when another job's tombstone records the source
          - records an exemption for that source row in the holding job's tombstone, with that
            job's id ("this source is not the subject"), and moves the row `held → released`
        - **A `released` row is fenced like a `claimed` one until its flip.** A leader-gated sweep
          sends each `released` row from its stored message through `withErasureFence` again,
          with the row's recipient hash and source id as keys, taking their stripes in shared
          mode. The exemption counts only for the job that recorded it. So any tombstone that
          records the source refuses the send, and another subject whose recipient hash matches,
          while the source is unrecorded, holds it again on that subject's candidate list. Phase 1
          and the lead step apply the provenance rule to `released` rows as they do to `claimed`
          ones. A row that passes takes the same guarded flip to `sending` as a `claimed` row, and
          goes on to the usual terminal states.
        - A later send from that source passes that job's fence and isn't held again by it. Any
          other job's fence still applies.
        - Dropping it, or `hold_expires_at` passing first, ends it `dropped` or `expired`, and
          deletes the stored message. A release after expiry is refused. The source reads that
          outcome, so a reminder flow knows its message never went out.
        - Test: R is held under A's erase, C is erased and C's lead step records L, then the owner
          releases R, and R is never sent. Run again with C's phase 1 committing between the
          release and the sweep: R is held again under C's erase instead of being sent, and once
          C's lead step records L it is fenced.
      - A send from a source created after the erase is a new contact, and the normal consent and
        do-not-contact rules govern it.
    - **Each writer drains for its own worst case, taken from the `externalSinks` registry.** The
      erase waits out each fenced writer's own worst-case duration, not just the gateway deadline.
      A closed list here left out Stripe, Wisetack and Google Calendar. So each subject-data entry
      in the registry declares its worst-case duration and its reconciliation read, and the
      structural test fails on an entry that is missing either. For example:
      - the gateway: the maximum gateway deadline
      - the QuickBooks client: its retrying 20-second requests, times its retry count
      - messaging and email: the provider client timeout
      - Stripe, Wisetack and Google Calendar: their bounded request timeout, times their retries
      - the recording and voicemail webhooks, the image post-process worker and customer MMS
        intake: their provider fetch plus their S3 write
      Each wait is a job checkpoint with a `next_attempt_at` and a deadline. Then it re-scans,
      within the job's bounded retries, until the result comes back clean.
      - **The declared duration is computed from the client's own constants, and enforced.** A
        number restated in the registry drifts. The QuickBooks bound lives in module-private
        constants (`MAX_RETRIES = 3`, `QBO_REQUEST_TIMEOUT_MS = 20_000`,
        `integrations/accounting/quickbooks-client.ts:28-32`). If someone raises `MAX_RETRIES`,
        the entry still says about 60 seconds. The erase's wait then ends early, the lookup finds
        nothing while the create is still retrying, the step records done, and the create lands
        afterwards with the customer's name, email and phone. So:
        - Each client exports the constants its timeouts and retries use, and its registry entry
          computes its duration from them.
        - `withErasureFence` stores `deadline_at = attempt_started_at + declared worst case` on
          the claim, and passes the write an `AbortSignal` that fires at that deadline. The scan
          checks that every fenced call site uses it (see "'Fenced' means bounded by the
          callback" above). No attempt or retry outlives its declared bound.
        - The reconciliation read runs after `deadline_at` plus the provider's processing
          allowance.
        - Tests: a fixture client whose retry loop would outlast its declaration is aborted at
          `deadline_at`. A unit test pins each entry's duration to at least timeout × attempts
          plus backoff, from the client's exported constants.
      - **The reconciliation read is tested, not only declared.** A new sink could ship with
        `reconcile: async () => ({ found: [] })` and pass the structural test. A create whose
        response was lost would then be recorded reconciled-absent while the provider holds the
        record. So each entry also supplies a mock of its provider. The per-registered-sink test,
        which already covers the claim fence, also drops a create's response and asserts that the
        entry's reconciliation read finds the record, and that the step deletes or anonymizes it.
        For a store whose outcome is `provider_retained`, such as email or Wisetack, it asserts
        that the row is linked and reported retained.
    - **An ambiguous business-integration create is reconciled with a strongly consistent read,
      not assumed absent.** Each write-ahead claim stores the idempotency key or request id it
      sent, and the account it sent it on.
      - **QuickBooks: idempotency through `requestid`, and absence proved by a query that sees
        inactive customers.** The create carries a stable key (`customer-<id>`,
        `sync-service.ts:288`), but sends it as a `Request-Id` header
        (`quickbooks-client.ts:64-66`). Intuit's idempotency key is the `requestid` query
        parameter, so the create isn't idempotent today. A timed-out first create followed by the
        catch-path re-create (`sync-service.ts:301-310`) gets "Duplicate Name Exists", and the
        customer sits in QuickBooks unlinked. QuickBooks has no lookup by request id, its queries
        return only active customers by default, and a customer "deleted" in its UI is only made
        inactive. So:
        - The create and the erase's anonymize update send their key as `?requestid=`, at most 50
          characters. The erase uses a hash of its idempotency key.
        - **A reused `requestid` replays its first answer, so a definite rejection gets a new
          one.** Intuit's `requestid` docs say a repeat request with the same id isn't run again:
          the service sends back the response it gave the first time. Suppose the first sparse
          update gets Stale Object Error 5010, because the bookkeeper edited the customer between
          our GET and our POST. The step reads the new `SyncToken`, retries with the same
          `requestid`, and gets 5010 again, on every retry, every daily re-open and every repeat
          `POST`. A create rejected with 6240 "Duplicate Name Exists" is replayed the same way
          after the tenant renames the customer, so it never syncs. So:
          - The `requestid` of each call is stored on the target row, or on the sync's claim,
            before the call.
          - A retry whose outcome is unknown (a timeout, a reset, a 5xx with no `Fault` body)
            reuses it, so a lost success is replayed, not repeated.
          - After a definite QuickBooks `Fault` (5010, 6240 or any validation fault), the next
            attempt derives a new `requestid` from the idempotency key plus an attempt counter,
            re-reads the `SyncToken`, and retries.
          - Test, against a mocked QuickBooks that stores and replays the response for each
            `requestid`: a first anonymize that gets 5010 succeeds on the retry, and a create that
            got 6240 succeeds after the rename.
        - When a create's outcome is unknown, the erase runs two QuickBooks queries, one on
          `DisplayName` and one on `PrimaryEmailAddr`, from the encrypted identifiers, each with
          `Active IN (true, false)`. (The query language has no `OR`.)
        - **QuickBooks renames an inactive customer.** A customer made inactive in the UI is shown,
          and returned, as "Jane Doe (deleted)". Say a first create for Jane, who has no email or
          whose email the bookkeeper cleared, is accepted but its response is lost, and the
          bookkeeper later deletes the unknown duplicate in the UI. An exact `DisplayName = 'Jane
          Doe'` query never finds "Jane Doe (deleted)", the email query finds nothing, and zero
          results would count as proof of absence while QuickBooks keeps her phone and
          addresses. So:
          - The name query is `DisplayName LIKE '<name>%'`, with quotes in the name escaped.
          - A row counts as a name match only when its `DisplayName`, after stripping a trailing
            " (deleted)", equals the subject's name. The legacy-row match and the read-back strip
            it the same way.
          - The QuickBooks mock renames a customer on inactivation the way QuickBooks does.
          - Test: a lost create with no email, which the bookkeeper inactivated, is still found
            and anonymized, or candidate-listed, and never recorded absent.
        - A customer that matches both is anonymized. One that matches only one goes onto the
          owner's candidate list, since a name or an email alone can belong to someone else.
        - Zero results from both queries is the only proof of absence.
      - **Stripe Search can't prove a customer absent.** Stripe documents Search as not for
        read-after-write: its index usually lags by under a minute, and longer during incidents. A
        lookup seconds after a lost `customers.create` (`payments/stripe-saved-card.ts:96-105`)
        could find nothing while the customer exists, with a card attached by
        `setup_intent.succeeded`. So:
        - The Stripe step lists customers instead (`GET /v1/customers`, which is consistent), on the
          claim's account. It lists those created between the claim's `attempt_started_at` and its
          `deadline_at`, widened by clock skew, and keeps those whose
          `metadata.customer_id` and `metadata.tenant_id` match. It deletes every one it keeps.
        - The list needs no raw identifier, so the erase never sends the erased name or email to
          Stripe again.
        - Search runs only as an extra pass, after a `not_before` past its indexing delay. It
          queries `metadata['customer_id']`, never the email, so it doesn't read the identifiers.
          Its empty result never counts as proof that the customer is absent.
      - Google Calendar reads back by the `serviceos_appointment_id` listing (see "Calendar
        events are found by the appointment id we stamp" above). Until that read succeeds, the
        store is `incomplete`.
      - **Wisetack is linked by its webhook, not read back.** No Wisetack lookup by our
        reference is named here, so a read-back could never succeed, and an "incomplete until
        read" rule would re-open and alert every day. The lender holds the data under its own
        obligations either way. So an ambiguous financing claim is linked when the webhook
        echoes its `external_reference`, and once Wisetack's webhook window has passed the row
        ends `provider_retained`, linked or not, like an ambiguous email. A read-back is added
        only if a documented lookup endpoint is named in this plan.
      - Test: against a mocked Stripe whose Search lags by 60 seconds, a create whose response was
        lost is still found by the list read and deleted.
    - Tests:
      - A gateway call is in flight when the erase starts. It completes afterwards, and its output
        is never persisted or exported.
      - **First sync versus erase.** The accounting sweep has loaded the customer and is paused
        inside its first QuickBooks create when the erase starts. Either the erase sees the claim,
        waits, then finds and anonymizes the QuickBooks customer, or the create is refused. It is
        never left holding the old name, email and phone.
      - A customerless send that begins after phase 1 has fully committed, sourced from a lead the
        erase scrubbed, is refused.
      - A reminder for customer B, who shares customer A's household phone, still goes out after A
        is erased.
      - A customerless send whose source row the erase didn't record, matching the shared phone, is
        held and candidate-listed. Releasing it sends it once, from the stored message, and a later
        send from the same source isn't held.
      - A hold nobody decides ends `expired` at its `hold_expires_at`, its stored message is gone,
        and a release after that is refused.
      - A sweep killed after a release commits still sends the released message once on restart.
      - A send sourced from a lead created after the erase goes through.
      - The structural test, run on fixtures planted with `plantTree`
        (`test/support/structural-scan.ts:238`):
        - fails on a fixture provider call site that isn't wrapped
        - fails on a second `fetch` added to a file that already has a registered one, when the new
          call has no fence and no id of its own
        - fails on `fetch` called through an alias, and on a `via` wrapper called outside any fence
        - fails on a class that stores `opts.fetch ?? fetch` in a property and calls it from a
          second, unmarked method
        - fails on `require('langfuse')` cast to an unregistered local interface
        - fails on a second public method that calls a `via` helper directly, bypassing the named
          wrapper
        - fails on a registry entry that no call site names
        - fails on a calendar `via` call inside an SMS fence, and on a callback that reaches two
          sinks
        - fails on an unmarked `new WebSocket(...).send(...)`, and on a `ws` client cast to the
          global `WebSocket` type with no entry
        - fails on a new `exempt` or `spend_exempt` id that the snapshot doesn't list, and on an
          `exempt` entry for a messaging surface
        - passes a call inside a `withErasureFence` callback whose `sinkId` is registered and
          is the call's own entry
  - **Fence outbound provider writes too, including ambiguous ones.** An outbound SMS can pass its
    tombstone check and then complete at Twilio after the provider cleanup has run.
    `notifications/send-service.ts:750-816` calls Twilio first and writes the `message_dispatches`
    row, with the returned SID, only afterwards. If Twilio accepts the message but our client times
    out, the catch path records a `failed` row with no SID. Nothing links the message to the
    subject, so a SID-only cleanup can't find it, and the erase would report success while Twilio
    still holds the recipient and the body. So:
    - **The check and the claim are one atomic step, serialized against the tombstone.** A
      separate check and insert would let a sender pause between them: the erase would commit its
      tombstone, find no in-flight row and report success, and the sender would then insert its
      row and send. So:
      - Every customer-facing outbound send writes a durable write-ahead dispatch row with status
        `claimed`. The row holds the recipient and its keyed hash (with its key id and
        normalization version), the account and the sending
        number, Messaging Service or address, the `customer_id`, the source (`source_type`,
        `source_id`) and a hash of the body.
      - It writes that row in one transaction that first takes the subject's erasure lock in
        shared mode. The lock is a `pg_advisory_xact_lock_shared` on the stripe of the customer
        id. A send with no customer id locks the stripe of its normalized recipient's keyed hash
        instead.
      - In the same transaction, in a statement after the one that took the stripe, it checks
        the tombstone, and it refuses the send when the tombstone matches (see "The tombstone
        probe is its own statement" above).
      - The erase's phase 1 takes the stripe of every key it writes into the tombstone in
        exclusive mode, as described above, the customer id and every normalized phone and email of
        the subject among them. It writes the tombstone under them.
      - **In the same transaction, phase 1 fences every sink's claims, not only the message
        rows.** Every sink's write-ahead claim takes the same guarded flip. Suppose the owner saves
        a card for the customer, and the Stripe saved-card claim commits just before phase 1. Its
        flip runs after phase 1, after an event-loop stall or an `await` between the claim and the
        flip. If phase 1 fenced only message rows, the flip would succeed and `customers.create`
        would send the name and email, after the Stripe step had found nothing to reconcile. The
        same holds for QuickBooks `ensureCustomerExternalId`, the Google Calendar insert, Wisetack,
        `putObject` and the trace export. So phase 1 moves to `fenced`, in every sink's claims
        table:
        - every `claimed` claim with a subject key that meets a tombstone key (the customer,
          session, call, correlation or owned-entity id)
        - every customerless `claimed` or `released` claim that the provenance rule fences (see
          "A claim already committed when phase 1 runs" and "A `released` row is fenced like a
          `claimed` one" above)
        - Test, per registered sink: a claim committed before phase 1, with its flip held until
          after phase 1 commits, fails the flip and makes no provider call.
      - Either a sender's row commits before the tombstone, and the erase sees it, or the sender
        sees the tombstone. No order lets both miss.
    - **The provider call starts only after a conditional flip.** Immediately before the call, at
      `markProviderStarting`, the sender runs one statement: `claimed → sending`, setting
      `attempt_started_at`, guarded on the status still being `claimed`. A `fenced` row fails that
      flip, and no provider call is made.
    - This covers SMS/MMS, email and outbound calls, on every path, including the direct Send
      Estimate/Invoice routes that no send claim wraps today.
    - **Each claim write commits on its own, whatever transaction the caller holds.** `POST
      /api/estimates/:id/send` (`routes/estimates.ts:944`) isn't in `LLM_LONG_CALL_ROUTES`
      (`middleware/tenant-context.ts:212`), so it runs inside the request transaction. That
      transaction commits only at `res.end`, and rolls back on a `>= 400` response, on a client
      disconnect before the response, or when its COMMIT fails (#1133). The dispatch repository
      is a `PgBaseRepository`, so it would join that transaction through `tenantContextStore`.
      The stripe, the `claimed` row, the flip and the SID write would all be uncommitted while
      Twilio is called. If Twilio accepts SM1 and the owner then closes the tab, the rollback
      removes the row and its SID, the status callback names a row that doesn't exist, and a
      later erase never targets SM1. The request would also hold its shared stripe across both
      provider calls of a `both`-channel send, past phase 1's budget, so phase 1 would time out
      whenever such a send is in flight. Today's `send_claims` avoids this by writing through
      `pool.query` (`notifications/send-claim-ledger.ts:68`). So:
      - For every sink whose write is a provider call, `withErasureFence` runs the claim
        transaction (stripes, tombstone check, claim insert), the guarded flip, and each terminal
        write (`sent` with its SID, `failed`, `ambiguous`) on its own connection, outside any
        ambient transaction (`runOutsideRequestTransaction`, `middleware/tenant-context.ts:676`).
        Each commits before the next starts. The claim is durable before the call, and the
        stripe is held only for the short claim transaction.
      - **Those connections come from a small dedicated pool, not the main one.** That
        function's comment warns that a fresh checkout can wait on the request's own client, and
        `middleware/tenant-context.ts:222-226` records the incident: in-app voice turns that
        each held two connections "deadlocked on checkout and 500'd every tenant's /api". A
        caller that holds a main-pool client and awaits a second checkout from the same pool can
        repeat it. So the claim, flip and terminal writes run on the same dedicated pool as U8's
        spend module (see U8's "They run on a small dedicated pool"). Every transaction on it
        sets a `lock_timeout`, so a wait on a lock that a main-pool transaction holds ends in an
        error, never a hang.
      - The direct send routes (`routes/estimates.ts:944`, `routes/invoices.ts:649`) also move
        onto a route list that runs with no request transaction, like `LLM_LONG_CALL_ROUTES`,
        and hold one connection while they wait on the provider.
      - A local-write fence may still join the caller's transaction.
      - A structural check fails on a provider-sink claims repository that takes its client from
        `tenantContextStore`.
      - Docker-gated test: a `POST /api/estimates/:id/send` whose client disconnects after mocked
        Twilio accepts keeps its claim and SID, and a later erase deletes the message.
    - **Terminal states:**
      - A success fills in the SID and marks the row `sent`.
      - A definite provider rejection (a 4xx with an error body) marks it `failed`; nothing exists
        at the provider.
      - A timeout, connection reset or 5xx without a SID marks it `ambiguous`, not `failed`.
    - **A provider-side unique correlation links ambiguous sends.** Matching on From, To and the
      body hash is not unique: identical appointment reminders to two customers who share a
      household phone have the same tuple, and a match would delete the other customer's history.
      So each SMS send passes a per-send `StatusCallback` URL that carries the write-ahead row's
      id. The status-callback handler is built on the webhook base (P0-014) and signature-checked.
      It records the SID on that row even when our create call timed out. A row linked this way is
      deleted like any linked SID.
    - **An outbound call needs its own correlation, and its own fallback.** `initiateOutboundCall`
      POSTs `Calls.json` with the agent as `To` and the bridge as `Url`
      (`telephony/outbound-call-service.ts:250-266`), and sets no `StatusCallback`. When the agent
      answers, the bridge `<Dial>`s the customer as a child leg. If the create times out after
      Twilio accepted it, the row is `ambiguous` with no SID. The Calls step selects only stored
      SIDs, and the only fallback below lists Messages. So the parent Call, the child leg with the
      customer's number and its recordings would stay at Twilio, and the job would end
      `erase_incomplete` every day. So:
      - Every `Calls.json` create passes a per-call `StatusCallback` with
        `StatusCallbackEvent=initiated`. Its URL carries the tenant id and the write-ahead row id.
        The handler is built on the webhook base (P0-014), signature-checked, and records the SID
        on the row like the SMS callback, job row first.
      - The bridge callback, which Twilio sends with the parent's `CallSid`, records the SID too,
        job row first, and retries once on `40P01` (see "One lock order: the job row first"
        above).
      - A call row still unlinked once its deadline has passed (the ring timeout plus `TimeLimit`
        plus a margin) falls back to listing its account's Calls by the row's `To` and `From`,
        kept to its `date_created` window. One match is linked, and its children are then found
        through `ParentCallSid` as above. Several go on the candidate list. Zero is recorded
        reconciled-absent.
      - Test: a call create whose response is lost is linked by its callback, and the parent and
        child legs are deleted. With the callback lost too, the fallback finds and deletes them.
    - **Email needs its own correlation, and its own erase outcome.** The SMS callback above
      doesn't cover email. When SendGrid or Twilio Email accepts a request but our client times out,
      the provider id (SendGrid's `x-message-id`, Twilio Email's `operationId`) arrives only in the
      lost response (`twilio-delivery-provider.ts:361-380`, `twilio-email-delivery-provider.ts:215-231`).
      So:
      - Each email send carries the write-ahead row's id in the provider's per-message custom
        metadata. For SendGrid that is `custom_args`, which its Event Webhook echoes back.
      - A signature-checked event handler, built on the webhook base (P0-014), records the
        provider message id on that row from the first event.
      - If a provider can't echo per-message metadata, its ambiguous rows can't be linked. They are
        never matched by recipient alone.
      - **Erase outcome.** Neither email provider offers a per-message delete. The manifest
        classifies their activity logs as provider-retained, under the provider's own retention.
        So an ambiguous email row ends `provider_retained` once the provider's event window has
        passed, linked or not. It can't block the erase forever.
      - The erase result lists those rows as retained by the provider, with that retention period,
        and never as deleted.
      - **SendGrid's suppression lists are a store of their own.** An email to the subject that
        bounced, was blocked or was reported as spam puts the address on SendGrid's bounces,
        blocks, invalid-email or spam-report list. Those entries don't expire, and each can be
        deleted through the Suppressions API (`DELETE /v3/suppression/bounces/{email}` and its
        siblings). A result that printed the Email Activity retention would tell the owner the
        address leaves SendGrid on a date when it stays for good. So:
        - The email store's manifest entry includes the suppression lists.
        - The email step deletes the subject's addresses from bounces, blocks and
          `invalid_emails`, which are deliverability records, and reads each list back.
        - Spam reports and unsubscribes are suppression records, like consent and DNC rows. They
          stay, and the result lists them `provider_retained` with no expiry.
        - Those deletes and read-backs need the raw addresses, so the email step is a declared
          reader of the identifiers.
      - Test: an email send whose response is lost is linked by its event, and resolves
        `provider_retained`. An unlinked one resolves `provider_retained` after the window. The
        erase completes, listing both as provider-retained.
    - **Rows the callback never linked fall back to a strict content match, which proves absence
      only once the message can no longer be sent.** A tenant registered for A2P sends through a
      Messaging Service, with `MessagingServiceSid` and no `From`
      (`notifications/per-tenant-twilio-delivery-provider.ts:94-99`), and Twilio picks the number
      from the pool. A message still waiting in the service's queue has no `date_sent`, and can
      wait up to its `ValidityPeriod`, 36,000 seconds by default. Link shortening and smart
      encoding can change the body Twilio stores. A filter on the row's sender, over a `DateSent`
      window, matched by body hash, would find nothing in each of those cases and record a message
      Twilio still holds, and may still deliver, as reconciled-absent. So:
      - Each write-ahead row records the account SID, and either the `MessagingServiceSid` or the
        bare `From`.
      - **The fallback reads its target, never the dispatch row.** `message_dispatches` has
        `customer_id` and `recipient TEXT NOT NULL` (`schema.ts:8186`, `:1101`), so the catalog
        and per-column rules make `recipient` a designated column. The local scrub blanks it
        within minutes of `snapshot`, and nothing orders that scrub after the Twilio messages
        step, whose fallback runs hours later. A fallback that read the row would list Messages
        with an empty `To`, find none, and record a message Twilio still holds as
        reconciled-absent. So:
        - When a dispatch row becomes a Twilio messages or email target, at phase 1 or at
          `snapshot`, the target copies the account SID, the Messaging Service SID or `From`, the
          `To` encrypted with `encrypt`, the body hash and the send window.
        - The fallback below reads only the target. The uniqueness check compares other rows by
          their keyed recipient hash, which the scrub keeps, as the tombstone does.
        - The target's encrypted `To` is nulled in the transaction that makes the target
          terminal.
        - A sink whose claims live in a table of their own, classified `keep`, marks the raw
          recipient "subject data, blanked", and nulls it at the claim's terminal transition.
        - Test: an ambiguous send whose dispatch row is scrubbed before the fallback deadline is
          still found by the fallback and deleted, and afterwards no table holds the phone.
      - Every customer-facing SMS is sent with an explicit `ValidityPeriod`, `SmartEncoded=false`
        and no `ShortenUrls`, so the body Twilio stores is the one we hashed. The not-yet-linked
        wait's deadline is that period plus a carrier margin.
      - The fallback lists the target's account's Messages by the target's `To`, adding `From`
        only for a bare-number send, with no `DateSent` filter. It keeps the messages whose
        `messaging_service_sid` or `from` matches the target and whose `date_created` falls in
        the send window (the row's `attempt_started_at` to the client timeout after it, widened
        by clock skew), and compares their body hash.
      - It accepts a match automatically only when both hold:
        - exactly one Twilio message matches
        - no other write-ahead row, for any customer in the tenant, has the same sender,
          recipient hash and body hash in an overlapping window
      - Anything else goes onto the owner-confirmed candidate list. That includes a message from
        the target's sender to its `To`, in its window, whose body doesn't match.
      - The fallback runs once the wait's deadline has passed. Zero messages from the target's
        sender to its `To` in the window then counts as Twilio never having accepted the message,
        and the row is recorded reconciled-absent.
      - Test: a Messaging Service send whose response and status callback are both lost, and that
        stays queued for hours, is found by the fallback and deleted once Twilio has finished with
        it. It is never recorded reconciled-absent.
    - **The erase never reports success while a linked row is open.** It waits until every row
      linked to the subject is terminal:
      - `sent`, with its SID deleted
      - `failed`
      - `ambiguous` and reconciled
      - **A send that crashed mid-call gets a resume path too.** A sender that dies after the
        `claimed → sending` flip leaves a row nobody will finish. The job's Twilio messages step
        moves any subject row still `sending` past its provider timeout to `ambiguous`, with a
        guarded transition, and reconciles it like any other ambiguous row. A late result from the
        original sender still lands: `ambiguous → sent` with the SID is allowed.
      - A row that still can't be reconciled after the step's retries leaves the Twilio messages
        store `incomplete`, which ends the job `erase_incomplete` with its one alert. The erase stays
        incomplete until every row clears or the owner closes it from the candidate list.
  - **Scrub:**
    - the `customers` row and `customer_contacts`
    - `customer_custom_field_values`: the arbitrary `value` column (`schema.ts:4733-4741`) can hold
      gate codes, dates of birth or account references
    - the customer's `service_locations`: street, city, postal code, latitude/longitude and access
      notes, all linked by `customer_id` (`schema.ts:338-352`). Anonymize these rather than delete
      them, because jobs and appointments still reference the rows. Their `customer_id` is
      `NOT NULL`, so their method is `keep-link`.
    - SMS conversations and message bodies
    - customer-linked notes
    - `call_transcript_turns`, `call_summaries`, `knowledge_chunks` by source
    - `voice_sessions.transcript`, `voice_recordings.transcript`
    - stored audio (S3 and Twilio)
    - entity aliases and correction lessons that reference the customer
    - `ai_runs` content, found two ways:
      - **Linked rows.** Rows whose `correlation_id` is one of the subject's conversation, session or
        call ids. U2 (OBS-2) makes every drafting call carry that id; before U7 ships, check that the
        classifier, summary and other voice-path gateway calls carry it too, and close any gap.
      - **Historical rows.** Rows written before that linkage have random correlation ids, so match
        them by content instead. Use a tenant-scoped, batched scan of `input_snapshot` /
        `output_snapshot` text for the subject's normalized phone numbers, email and full name. U4's
        purge has already scrubbed anything older than the window it last applied, so the scan
        starts from the tenant's oldest remaining `ai_runs` row, not from the current retention
        setting. A window shortened since the last purge would otherwise hide rows the purge hasn't
        reached yet.
      - **The scan also matches the subject's ids.** A drafting prompt can carry only the resolved
        customer id and non-identifying job details. For example, `estimate-task.ts` serializes
        `context.existingEntities`, including the verified `customerId`, into the user message, and
        `gateway.ts` stores that message verbatim under a random correlation id. A phone, email and
        name scan finds nothing in such a row. So:
        - The historical scan also matches the customer UUID, and the UUIDs of the subject's jobs,
          estimates, invoices and appointments.
        - A UUID is unique to the subject, so a UUID match counts as corroborated on its own, and
          that row is scrubbed automatically.
      - **A content match is a candidate, not proof.** Names, phones and emails are not unique per
        customer (`packages/api/src/db/schema.ts:325-328`): two customers can share a name, and a
        household can share a phone. The scrub is irreversible, so it runs automatically only for a
        corroborated row, which meets both of these:
        - its text carries at least two of the subject's identifiers
        - no other customer or contact in the tenant shares any identifier that matched
      - Every other match goes onto a candidate list, returned with the erase result and shown to the
        owner. Those rows are scrubbed only after the owner explicitly confirms them.
      - The erase result reports how many rows each strategy scrubbed, and how many candidates are
        still waiting.
  - **Anonymize** jobs, invoices, payments and estimates, and keep the amounts for tax and legal
    retention. Their PII is blanked. Their links are `NOT NULL` (`jobs.customer_id`,
    `estimates.job_id`, `invoices.job_id`, `payments.invoice_id`), so each keeps its link to the
    blanked row (`keep-link`, see "Each `anonymize` table names how it treats its link").
  - **Keep** `consent_events` and DNC rows as suppression records, hashing the phone if counsel
    requires it.
- **Test scenarios:** one Docker-gated integration test that seeds a customer across every store,
  erases them, and asserts:
  - each store is scrubbed, including a pre-linkage `ai_runs` row found only by content and a linked
    row found by `correlation_id`
  - the customer's `service_locations` rows keep their ids but lose street, city, postal code,
    coordinates and access notes
  - a seeded `customer_custom_field_values` value is gone
  - a customer MMS photo (a `files` row with `entityType: 'customer'`) is deleted along with its S3
    object
  - a call recording, a job photo and an attachment of the subject: each `files` row is deleted,
    or blanked where a kept row still references it, each S3 object is gone, and no step fails
    with `23503`
  - a QuickBooks sales receipt whose line description names the subject, and a Stripe
    payment-link Product named after the subject, hold none of the subject's identifiers
  - **schema coverage:** the manifest test fails when a test-only migration adds a new table with a
    `customer_id` foreign key that the manifest doesn't list, and also when it adds a bare
    `…_customer_id` column with no foreign key
  - a lead converted into the customer (linked only by `converted_customer_id`, with no foreign key)
    has its name, phone, email, notes and service address scrubbed
  - a `call_me_back_tasks` row linked only through the customer's voice session has its caller phone,
    name, message and intent summary scrubbed
  - with content capture on, the subject's Langfuse traces are deleted through the API (a mocked
    Langfuse endpoint). When the delete fails, the erase result marks that store incomplete and
    alerts.
  - a trace queued before the erase whose transport is delayed until after it is never recreated: it
    is dropped at the send boundary, or deleted again on the second pass
  - with capture turned off since an earlier capture-on interval, the erase still deletes that
    interval's subject traces. A pre-linkage run that the historical scan scrubs has its trace,
    keyed by its random correlation id, deleted too.
  - against mocked Stripe, QuickBooks, Twilio Messages and Twilio Calls APIs:
    - the subject's completed Call resources, child legs included, are deleted. A child leg we
      never stored is found through `ParentCallSid` and deleted before its parent. A call still in
      progress keeps the store `incomplete` until it completes, and then it is deleted.
    - the Stripe Customer is deleted
    - the QuickBooks customer's `DisplayName` is replaced and its email and phone are cleared. An
      inactive QuickBooks customer from a lost create is still found, against a mock that renames
      it "<name> (deleted)" on inactivation, and the create and the update each send
      `?requestid=`. A receipt from a lost receipt create is found by its `CustomerRef` and
      rewritten. Against a mock that fills `PrintOnCheckName` from
      `DisplayName` on create, the anonymize overwrites it, and the read-back finds none of the
      subject's identifiers in any name or contact field.
    - a Message delete that returns 20009 waits and retries without using up the step's retries,
      and a disconnected integration ends its store `provider_retained`, with one alert
    - a burst of deletes that Twilio answers with 429 and a `Retry-After` waits out each one,
      uses none of the step's retries, and ends `done` with no alert
    - each of the customer's linked Twilio Messages returns 404 after the erase, and its Media
      list is empty
    - a message from a shared household number that isn't linked to the subject is left alone and
      listed as a candidate
    - a failure at any provider marks that store `incomplete` and alerts
  - erase versus in-flight outbound SMS, against real Postgres and a mocked Twilio Messages API:
    - **Paused between check and claim.** A sender is paused after it takes the shared lock, and
      the erase starts. The erase waits for the lock. Once the sender's row commits, the erase sees
      it and fences or drains it. A sender that reaches the lock after the tombstone sees it and
      makes no provider call.
    - **Fenced before the flip.** A sender is paused after its row commits but before the
      `claimed → sending` flip. The erase moves the row to `fenced`, the flip fails, and no provider
      call is made.
    - **Held at the provider.** A send is held at the provider when the erase starts, and Twilio
      accepts it afterwards. The erase waits for the row to be terminal and deletes its SID.
    - **Timed out, then linked by the callback.** Twilio accepts a send but the client times out,
      so the row is `ambiguous`. The status callback links the SID through the row id, and the
      erase deletes that message.
    - **Not unique.** An ambiguous row whose From, To and body hash match two Twilio messages is
      not auto-matched. The same goes for a row that conflicts with another customer's row
      (household reminders). Neither message is deleted, the row is candidate-listed, and the
      erase is `incomplete`.
    - **Sender died mid-call.** A sender dies after the `claimed → sending` flip. After the
      provider timeout the job moves the row to `ambiguous` and reconciles it. A row that still
      can't be reconciled ends the job `erase_incomplete`, with one alert.
  - after an erase, the exporter still sends unrelated traces, so the drain did not shut it down
  - a drain failure marks Langfuse `incomplete`
  - with phase 1 committed, an in-flight writer in another connection sees the tombstone and drops
    its content while phase 2 is still running
  - with two customers sharing a full name, the other customer's row is untouched
  - a row that matches only a household-shared phone lands on the candidate list and is scrubbed only
    after confirmation
  - financial amounts remain
  - suppression remains
  - an audit event is written
  - a non-owner gets 403 on the erase, and on each candidate confirmation, dismissal, release and
    drop
  - another tenant's data is untouched
  - **the erasure job survives a crash**, against real Postgres and the mocked providers:
    - **Restart right after phase 1.** The process is killed once phase 1 commits, before any
      phase-2 step runs. On boot the sweep claims the job and finishes it. The erase record is
      written first, every store is erased, `erase_completed` is written once, and writers stay
      fenced throughout.
    - **Crash after each later checkpoint.** For each step in turn, the process is killed once just
      after the step's checkpoint commits, and once between a provider delete and its checkpoint.
      On resume, no checkpointed target is sent a second delete. A repeated delete that returns 404,
      for the Stripe Customer or a Twilio Call, or 410 for a calendar event, is recorded `done`,
      not as a failure. The job completes.
    - **Resume after the links are gone.** The process is killed after the scrub has nulled the
      nullable links and blanked the `customers` row and the jobs behind the invoices. The
      resumed Stripe, QuickBooks,
      `invoice_line_items` and historical `ai_runs` steps still find every target, from the step
      rows and the job's encrypted identifiers. Once those steps are done, no
      `customer_erasure_identifiers` row remains for the job.
    - **Snapshot before severing.** The process is killed partway through `snapshot`. On resume
      it records each external id once, and no scrub step started before it was done.
    - **Two workers race.** The queue handler and the boot sweep claim the same job at once.
      Exactly one claim succeeds, and each provider delete is sent once. A worker whose lease
      lapsed mid-step has its next checkpoint refused, and makes no further provider call.
    - **A checkpoint races a re-claim.** A worker's lease has lapsed, and its pre-call checkpoint
      is held before commit while another worker claims the job. Exactly one of them calls the
      provider for that target.
    - **Bounded retries.** A provider that fails every time ends its step `incomplete` after the
      retry limit. The job ends `erase_incomplete`, naming that store, with one alert. A repeat
      `POST` retries only that step. If that step ends `incomplete` again, a second alert fires.
      The tombstone fences writers the whole time.
    - **A step that crashes every run.** A step calls `process.exit()` on every run. After the
      retry limit it ends `incomplete`, and the job ends `erase_incomplete` with one alert.
    - **A callback that never arrives.** An SMS whose client timed out before Twilio accepted it
      stays `ambiguous`, and no status callback ever comes. Past its deadline (the send's
      `ValidityPeriod` plus the margin) the step falls back to the content match, finds nothing and
      records reconciled-absent. The job ends terminal.
    - **A late target races the close.** A status-callback handler is held between its step update
      and its commit while the worker closes the job. Once both commit, the job isn't terminal. The
      sweep runs the re-opened step, the SID is deleted at Twilio, and the job closes again with one
      audit event for that generation.
    - **A late target races a running step.** A status callback adds a SID to the Twilio messages
      step while it runs, and commits between the step's target read and its `done` checkpoint.
      The step doesn't end `done` until that SID is deleted, and the job then closes once.
    - **A source that skips the re-open.** A raw `INSERT` of a target into a `done` step of a
      `completed` job, made after the job-lock helper, leaves the job `pending`, and the sweep
      then processes the target. The same insert without the helper raises.
    - **The job row first.** A callback is held between its job-row update and its dispatch-row
      update while a checkpoint moves the same dispatch row. Both commit, with no `40P01`.
    - **Age alarm.** A job still not terminal past the age limit raises one job-age alert. An age
      alert followed by an `erase_incomplete` close at the same generation sends both alerts. A
      job re-opened by the daily retry after the age limit raises no age alert unless it stays open
      past the limit again. A job stuck in its first opening raises the age alarm, and a job with
      no targets that closes `erase_incomplete` alerts once.
    - **Identifier retention.** An `erase_incomplete` job whose historical scan keeps failing
      reaches the identifiers' maximum retention while a worker is mid-scan. The identifiers are
      deleted, the worker's next checkpoint is refused, and that step ends `inputs_expired`. The
      job ends `erase_incomplete` with one alert, and the daily retry and a repeat `POST` leave
      that step alone.
  - **the lock covers every tombstone key:** a writer that carries only a session id, or only an
    `invoice_id`, holds its shared stripe lock, paused before commit, when the erase starts. Phase 1
    waits for it, and phase 2 then scrubs what it wrote.
  - **phase 1 can't be starved, and gives way to a writer:**
    - With writers taking the subject's shared stripes back to back, phase 1 still commits within
      its retries.
    - A writer holds one shared stripe and waits for one that phase 1 holds, while phase 1 waits
      for the writer's. Phase 1 times out inside its budget, rolls back and retries. The writer
      commits, with no deadlock error.
    - A writer that holds a stripe past every retry gets the owner a typed `409`, and no tombstone
      or job row exists.
    - Phase 1's deadline, measured from its first grant, is below the value `SHOW deadlock_timeout`
      returns, less the margin.
    - **A slow collection.** The re-collection is slowed to most of the budget while a two-stripe
      writer waits on phase 1. Phase 1 rolls back, and the writer commits without a `40P01`.
    - **A writer already waiting on another writer.** A writer has waited 700 ms on another
      writer's row lock when phase 1 starts, and the three form a cycle. That writer commits after
      its one retry, and no writer fails with a deadlock error it doesn't retry.
  - **every U7 table is a tenant table:** the set comes from the catalog. A test-only migration that
    adds a child table keyed by `job_id` alone fails the test, and so does a fixture sink whose
    claims table has no `tenant_id`. A late target written under one tenant's context against
    another tenant's job id is refused.
  - **the erase record keeps no subject data:** a customer with an attachment named
    `Jane_Doe_passport.jpg` is erased. Phase 1's inserts aren't refused by the erasure trigger.
    Every mocked provider fails once with an error body that echoes the subject's name and email.
    Once the job completes, no U7 table holds that filename, in a key or an error, and no U7
    table, spend table or audit row holds the name or the email.
  - **the second Langfuse delete waits by time:** another process queues a subject trace before
    phase 1 and sends it after the first delete. The job's second delete, at `not_before`, removes
    it, even when the process that ran the first delete restarted in between.
  - **the historical scan ignores a newly shortened window:** the owner shortens the retention
    window, and the erase runs before the next purge. A pre-linkage `ai_runs` row older than the new
    window is still found and scrubbed.

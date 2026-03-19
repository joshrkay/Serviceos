# Voice Pipeline Production-Readiness Options

Date: 2026-03-18

## Current state (baseline)

The API now has a functional `/api/voice` route shape that:

- creates `VoiceRecording` records,
- runs them through the transcription worker flow,
- supports read + retry endpoints.

Today this is still wired to an **in-memory transcription provider** intended for plumbing validation in local/dev, not a production STT stack.

---

## Option 1 (Recommended): Direct STT provider integration (synchronous request path)

### How it works

1. Client uploads audio to object storage (R2/S3) and submits `fileId + audioUrl`.
2. API route calls a real STT provider directly (OpenAI/Azure/Google/etc.) in request path.
3. Response returns final transcript immediately.

### Pros

- Fastest path to a shippable MVP.
- Fewer moving parts to operate.
- Easier debugging in early rollout.

### Cons

- User request latency depends on provider turnaround.
- Harder to handle long files and burst load.
- Retries/timeouts can make request handling brittle.

### Good fit when

- Volume is low/moderate.
- Typical recordings are short.
- Team wants speed over scale initially.

---

## Option 2: Queue-first async transcription pipeline

### How it works

1. API validates + stores recording (`pending`).
2. API enqueues transcription job and returns `202 Accepted`.
3. Worker performs STT and updates recording status (`processing`, then `completed` / `failed`).
4. Client polls or subscribes to status updates.

### Pros

- Most scalable/reliable architecture.
- Better for long recordings and retries/backoff.
- Decouples API latency from STT latency.

### Cons

- More infrastructure and operational complexity.
- Requires client UX for async progress.

### Good fit when

- Throughput is expected to grow.
- Audio duration is highly variable.
- Reliability SLOs matter more than immediate transcript return.

---

## Option 3: Managed speech platform + webhook callback model

### How it works

1. API sends audio reference to provider job endpoint.
2. Provider processes asynchronously.
3. Provider webhook posts final transcript back.

### Pros

- Offloads scaling/ops burden to provider.
- Often includes diarization, language detection, punctuation, etc.

### Cons

- Webhook security and idempotency become critical.
- Less direct control over pipeline internals.
- Vendor lock-in risk.

### Good fit when

- Team wants to minimize custom worker operations.
- Feature depth from provider matters (speaker labels, domain adaptation).

---

## Core hardening checklist (required regardless of option)

## 1) Security and access controls

- Enforce tenant isolation on every voice read/update path.
- Verify `audioUrl` ownership and signed URL expiry.
- Validate MIME type/size/duration server-side before transcription.
- Encrypt audio at rest and in transit.

## 2) Reliability

- Add idempotency key handling on ingest + retry APIs.
- Implement bounded retries with backoff for provider failures.
- Add dead-letter strategy for exhausted jobs.
- Add structured failure reasons (`provider_timeout`, `unsupported_format`, etc.).

## 3) Observability

- Emit per-recording metrics: queue delay, transcription latency, failure rate.
- Add tracing from ingest request to worker completion.
- Capture provider error code taxonomy for alert routing.

## 4) Data model and lifecycle

- Add retention policy (e.g., raw audio TTL + transcript retention rules).
- Version transcript outputs if post-processing or edits are allowed.
- Store confidence, language, diarization metadata in normalized form.

## 5) Product/UX

- Display explicit statuses: `uploading`, `queued`, `processing`, `completed`, `failed`.
- Offer deterministic retry and user-facing failure reasons.
- Add cancellation handling for abandoned uploads.

## 6) Compliance and governance

- Define PII/PHI handling policies.
- Add redaction pipeline if required by customer segment.
- Ensure audit trail records who initiated/retried transcription.

---

## Recommended rollout plan

1. **Phase A (1–2 sprints):** Option 1 with a real STT provider and strict validation/metrics.
2. **Phase B:** Move processing to Option 2 (queue-first async) once traffic or latency requires it.
3. **Phase C:** Add advanced features (speaker diarization, summarization, structured extraction).

This gives a practical path to launch while preserving a migration route to a higher-scale architecture.

---

## Implementation note (current branch)

The voice API prototype has now been shifted toward **Option 2 semantics**:

- ingest/retry endpoints enqueue transcription work and return `202 Accepted`,
- transcription execution happens asynchronously in a worker loop,
- clients should read recording status (`pending` → `processing` → `completed` / `failed`) via fetch/polling.

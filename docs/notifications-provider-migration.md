# Notification provider literal migration (gateway naming)

## Scope

This migration replaces delivery-provider literals:

- `twilio-sms` → `sms-gateway`
- `twilio-sendgrid` → `email-gateway`

## Compatibility plan

We are using **read-time mapping** in the notifications repository layer.

- New writes now use canonical gateway literals (`sms-gateway`, `email-gateway`).
- Legacy rows already persisted with `twilio-sms` / `twilio-sendgrid` are normalized on read.
- Downstream analytics/reporting consumers reading through repository interfaces receive canonical values immediately.

## Deprecation window

- **Start:** May 4, 2026
- **End:** July 31, 2026

During this window, legacy provider strings are still accepted at read time.

## Final cutover date

- **Cutover:** August 1, 2026

On/after cutover, remove legacy literal mapping and (optionally) run a DB backfill for historical `message_dispatches.provider` values if strict canonical storage is required.

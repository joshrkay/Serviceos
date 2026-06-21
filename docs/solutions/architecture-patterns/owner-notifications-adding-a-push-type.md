---
title: "Adding an owner notification type (generic OwnerNotificationService)"
date: 2026-06-21
track: knowledge
problem_type: architecture-patterns
module: "packages/api/src/notifications, packages/mobile/src/push, packages/shared/src/contracts/notification.ts"
tags: ["notifications", "push", "expo", "owner-app", "deep-link", "rbac", "mobile"]
related: []
---

## Context
Owner-facing push started as a proposal-only path (`proposal-push-notifier.ts`
sent exactly two events). Lighting up every notifiable business event (incoming
call, inbound SMS, appointment reminder/cancellation, payment, invoice overdue,
lead, escalation/emergency) without copy-pasting the dispatch/targeting/
dead-token-prune logic per event required generalizing it. This documents the
end-to-end pattern so the next "add a notification" is a few lines, and records
the non-obvious pitfalls that cost time the first time.

## Guidance
A notification type flows through four layers. To add one, touch each:

1. **Shared taxonomy** — `packages/shared/src/contracts/notification.ts`. Add the
   string to `NOTIFICATION_TYPES`; the wire payload (`notificationDataSchema`)
   carries `type` + `screen` (absolute in-app path) + optional `entityId`. If
   it should interrupt (sound/alert in foreground), add it to
   `HIGH_PRIORITY_NOTIFICATION_TYPES`. Rebuild shared (`npm run build` in
   `packages/shared`) — the API imports the built dist, not the source.

2. **API descriptor** — `packages/api/src/notifications/owner-notification-service.ts`.
   Add an entry to `NOTIFICATION_DESCRIPTORS` and a context shape to
   `NotificationContextMap`: a `permission` (who receives it) and a `build(ctx)`
   that returns `{ title, body, data }`. Copy is short, blame-free, action-first.

3. **Producer seam** — call `notifyOwner(tenantId, type, ctx)` (from
   `owner-notifications-instance.ts`) at the business event. It is
   failure-isolated and a no-op if unregistered, so it can sit inside any
   handler/worker without a try/catch and never blocks the triggering path.

4. **Mobile routing** — `packages/mobile/src/push/notificationRouting.ts` routes
   by `data.screen` against an **allowlist**; if your `screen` is a new route,
   add it. Unknown/empty screens fall back to Home (never 404/throw).

Three pitfalls that are easy to get wrong:

- **Targeting permission must actually exclude technicians.** Every `*:view`
  permission (`payments:view`, `appointments:view`, …) is held by *all* roles
  including technician, so gating on `:view` notifies everyone. Use a permission
  only owner+dispatcher hold — `proposals:approve`, `dispatch:view`,
  `payments:create`, `invoices:update`, `customers:create`,
  `conversations:manage`. Targeting re-checks at send time, so a demoted user
  stops receiving automatically.

- **Never deep-link a `leadId` to `/customers/<id>`.** A CRM lead is a *separate
  id space* from a customer (`leads` table, own ids, no `customerId`), and
  `/api/customers/:id` resolves only the customer repo — so the tap 404s.
  Unknown-caller / new-lead notifications must route to a screen that resolves
  (the `/customers` list), or to the real customer id when one exists. Generally:
  before deep-linking an id, confirm the target route fetches *that* entity type.

- **Wire the optional deps in `app.ts`, or the seam is inert.** Workers/handlers
  that take new optional repos (`jobRepo`/`customerRepo`/`settingsRepo`/
  `dispatchRepo`, a name resolver) early-return without them. A seam that
  compiles and unit-tests green can still no-op in production until `app.ts`
  passes the deps. Grep the construction site and pass them.

## Why This Matters
The generalized service means new notification types don't re-implement fan-out,
RBAC targeting, or Expo `DeviceNotRegistered` pruning — one place, tested once.
The pitfalls each produced a real defect or near-miss: `:view` targeting would
have paged technicians; the lead deep-link 404'd on tap; the unwired worker deps
left the reminder/overdue pushes silently inert.

## When to Apply
Any owner-facing push/notification. The same shape (typed registry + late-bound
`notifyOwner` seam + mobile allowlist) extends cleanly to SMS/email owner
channels if needed.

## Examples
Producer seam (best-effort, no try/catch needed at the call site):

```ts
// inside an existing handler/worker — never blocks the triggering action
await notifyOwner(tenantId, 'incoming_call', {
  // known caller → their customer record; unknown → omit, descriptor routes to list
  ...(customerId ? { customerId } : {}),
  callerLabel,
});
```

Descriptor with the deep-link guard built in:

```ts
incoming_call: {
  permission: 'conversations:manage', // owner+dispatcher, NOT technician
  build: (ctx) => ({
    title: 'Incoming call',
    body: `${ctx.callerLabel} is calling.`,
    data: {
      type: 'incoming_call',
      // lead has no detail route → list; real customer → detail
      screen: ctx.customerId ? `/customers/${ctx.customerId}` : '/customers',
      ...(ctx.customerId ? { entityId: ctx.customerId } : {}),
    },
  }),
},
```

Tests: unit-test the seam via `setOwnerNotifications(new OwnerNotificationService(
{ deviceTokenRepo, provider: new InMemoryPushDeliveryProvider() }))` and assert
on `provider.sent[].data`. Pin the targeting (a technician device is excluded)
and the deep-link `screen` so a future change can't silently re-break either.

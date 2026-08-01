---
title: "Keep aria-label field keys when migrating hand-rolled forms to the UI kit"
date: 2026-06-24
track: knowledge
problem_type: conventions
module: packages/web/src/components/ui, packages/web/src/pages
tags: ["forms", "accessibility", "aria-label", "testing-library", "ui-kit", "migration", "field"]
related: ["docs/solutions/architecture-patterns/web-palette-to-token-class-migration.md"]
---

## Context

Migrating a hand-rolled form (`<label>First name <input aria-label="firstName"/>
</label>`) to the shared kit (`<Field label><Input/></Field>`, which adds the real
`htmlFor`/`id` wiring the hand-rolled form lacked) has a trap: the existing tests
query controls by their **camelCase field key** via the `aria-label` —
`screen.getByLabelText('firstName')`, `getByLabelText('communicationNotes')`.

Two tempting moves both break things:
- **Humanize the label** (`Field label="firstName"` → `"First name"`) and every
  `getByLabelText('firstName')` fails (no matching accessible name).
- **Drop `aria-label`** and rely on the `Field` label — changes each control's
  accessible *name* from the key to the human label, again breaking the queries
  (and silently changing what a screen reader announces).

## Guidance

**Keep the `aria-label="<fieldKey>"` on each kit control, and put the human label
in `Field`.** The kit `Input`/`Select`/`Textarea` forward `aria-label` to the real
element; `aria-label` takes precedence over the `<label htmlFor>` for the
accessible name, so:

- `getByLabelText('firstName')` keeps resolving (via `aria-label`) — tests stay
  green with zero churn.
- The accessible name is unchanged from before the migration — **zero a11y
  regression** (and humanizing labels becomes a separate, intentional copy +
  test-query change, not an accidental break).
- `Field` still generates a stable `id`, injects it into the control (the kit
  spreads `...rest`, so the `id` reaches the real `<input>`/`<select>` even when
  the kit wraps it in a layout `<div>`), and renders `<label htmlFor>` — so the
  htmlFor/id pairing the hand-rolled form was missing is now present too.

Two gotchas:

- **Don't pass `error` to `Field` if the form keeps a single top-level
  `role="alert"`.** `Field` renders its *own* `<p role="alert">` when given an
  `error`, and `screen.findByRole('alert')` (singular) throws on multiple matches.
  Keep one error surface.
- **Add `min-h-11` to controls and buttons.** Kit defaults can be under 44px
  (e.g. `Button size="md"` is `h-10` = 40px); `min-h-11` (44px) wins over the
  fixed height and satisfies the tap-target rule.

## Why This Matters

It lets a structural/visual migration land as a true no-behavior-change commit:
the form gains the kit's focus/label/error semantics and Path A styling while the
test contract and accessibility names are byte-for-byte preserved. The risky part
of a form migration (silently breaking accessible names) is removed.

## When to Apply

Migrating any `packages/web` hand-rolled form to the kit where the existing tests
query controls by `getByLabelText('<camelCaseKey>')` (i.e. by the `aria-label`).

## Examples

```tsx
// before
<label className="text-xs text-slate-500">
  First name
  <input aria-label="firstName" value={form.firstName} onChange={…}
         className="w-full rounded-lg border border-slate-200 px-3 py-2" />
</label>

// after — human label in Field, aria-label key preserved, 44px target
<Field label="First name">
  <Input aria-label="firstName" value={form.firstName} onChange={…}
         className="min-h-11" />
</Field>
// getByLabelText('firstName') still matches (via aria-label); the <label for>
// now also associates "First name" → control. No test or a11y-name change.
```

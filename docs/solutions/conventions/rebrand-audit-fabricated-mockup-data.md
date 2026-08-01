---
title: "Content rebrand audits: case-insensitive grep + a positive render test catch fabricated mock data"
date: 2026-06-25
track: knowledge
problem_type: conventions
module: packages/web/src/components/customer
tags: ["rebrand", "mock-data", "design-mockup", "figma-export", "grep", "testing", "customer-facing", "vitest"]
related: ["docs/solutions/architecture-patterns/brand-rebrand-via-semantic-token-swap.md", "docs/solutions/architecture-patterns/web-palette-to-token-class-migration.md"]
---

## Context

The Rivet/ServiceOS rebrand left a stale "Fieldly" string in the customer
`EstimateApprovalPage`. What looked like a one-line string swap turned out to be
several **fabricated mock-data stand-ins** that a Figma-derived component shipped
with and that were never wired to real data: the brand name + initial avatar
(×2), a fake phone, a `mailto:info@fieldly.pro` email, a hardcoded acceptance
date ("March 10, 2026" in two places), and a mock job number ("JOB-1053") — all
rendered to real customers after they accept an estimate.

This is the **content** sibling of the color-token rebrand
(`brand-rebrand-via-semantic-token-swap.md`): that one is about palette classes;
this one is about fabricated *text/data* that mockup components leave behind.

## Guidance

When auditing a rebrand or wiring a component adapted from a design mockup
(anything under `figma-export/`, or a screen that "looks done" but renders
suspiciously specific sample data):

1. **Grep case-insensitively, and search embeddings of the brand — not just the
   display name.** `grep -n Fieldly` returns 0 while `grep -ni fieldly` finds
   `info@fieldly.pro`. Brands hide in emails, domains, URLs, handles, and CSS
   `content:` — all often lowercased. Always `grep -i`, and grep the slug form.

2. **A single component can have a wired path and an unwired path for the same
   field.** Here the non-success header already rendered `{businessName}` while
   `SuccessScreen` hardcoded "Fieldly Pro Services". Find the sibling that does
   it right and mirror it; the unwired path is the bug.

3. **Hunt every fabricated stand-in, not just the brand string.** Mockups stamp
   plausible-looking names, dates, IDs, phones, emails, addresses. Sweep:
   `grep -niE 'fieldly|JOB-|555-|@.*\.(pro|com)|austin|march 10|example|demo|lorem'`
   over the touched files and widen the alternation as you find more.

4. **Pin it with a *positive* render test, not just a grep.** Render the actual
   customer-facing state and assert the **real** data surfaces *and* the
   fabricated value is absent. A grep only knows today's strings; a render test
   guards the behavior and surfaces stand-ins you didn't think to grep — in this
   case the test failed on a second hardcoded phone+email in a contact footer
   that the first grep had missed.

5. **No real data source → drop the element; don't invent a placeholder.** The
   estimate view exposes `businessName`/`businessPhone` but no tenant email,
   city, or job number, so the email link, the "Austin, TX" line, and the mock
   job number were *removed* (and the phone made conditional). Showing a real
   customer a fabricated value is worse than showing nothing.

6. **"Today"-style dates: wire to `new Date()` and test with frozen time.** The
   signing sheet's "Accepted on" is the moment of signing, so it became
   `fmtFriendlyDate(new Date().toISOString())`, tested deterministically with
   `vi.useFakeTimers({ toFake: ['Date'] })` + `vi.setSystemTime(...)` (faking
   only `Date` keeps `findBy`/`waitFor` on real timers). A persisted date (the
   success screen's "Accepted") wires to the real `acceptedAt` with a bare-label
   fallback when absent.

## Why This Matters

Fabricated data on a public/customer surface is a correctness *and* trust bug —
a customer seeing another company's name, a wrong acceptance date, or a fake job
number they can't reference later. These leaks survive a naive rebrand because
(a) case-sensitive grep misses lowercased/embedded forms and (b) grep can't see
the difference between a wired and an unwired render path. A positive render test
closes both gaps and keeps them closed.

## When to Apply

- Any rebrand touching customer-facing or public text (not just colors).
- Wiring/adapting a component that originated as a static design mockup
  (`figma-export/`), or a screen that renders specific sample data.
- Any time `grep <Brand>` comes back "clean" but you haven't run `grep -i` or
  checked emails/URLs/IDs/dates.

## Examples

Brand + contact, unwired → wired (`EstimateApprovalPage.tsx` `SuccessScreen`):

```tsx
// Before — hardcoded mockup data shown to every customer
<span ...>F</span>
<p ...>Fieldly Pro Services</p>
<p ...>Austin, TX</p>
<a href="tel:5125550000">…</a>
<a href="mailto:info@fieldly.pro">Email us</a>   // lowercase: grep Fieldly missed this

// After — real tenant identity, mirroring the live non-success header
<span ...>{businessName.charAt(0).toUpperCase()}</span>
<p ...>{businessName}</p>
{businessPhone && <p ...>{businessPhone}</p>}
{businessPhone && <a href={`tel:${businessPhone.replace(/\D/g, '')}`}>…</a>}
// city + email dropped: the estimate view exposes neither
```

Positive render test that also surfaced the missed footer leak
(`EstimateApprovalPage.success.test.tsx`):

```tsx
renderAccepted(acceptedView({ businessName: 'Acme HVAC' }));   // status:'accepted' → SuccessScreen
await screen.findByText('Estimate accepted!');
expect(screen.getAllByText('Acme HVAC').length).toBeGreaterThanOrEqual(2); // header + job card
expect(screen.queryAllByText(/Fieldly Pro Services/i)).toHaveLength(0);
expect(screen.queryAllByText('JOB-1053')).toHaveLength(0);
expect(screen.getByText(/Mar 15, 2026 · Estimate approved/)).toBeInTheDocument(); // real acceptedAt
```

Frozen-time test for a `new Date()` "today" stamp:

```tsx
vi.useFakeTimers({ toFake: ['Date'] });            // fake only Date; findBy stays on real timers
vi.setSystemTime(new Date('2026-07-04T12:00:00Z'));
try {
  /* open the signing sheet */
  expect(await screen.findByText('Jul 4, 2026')).toBeInTheDocument();
  expect(screen.queryAllByText(/March 10, 2026/)).toHaveLength(0);
} finally { vi.useRealTimers(); }
```

Reference commit: `b6e62104` (de-fabricate the customer estimate-approval screens).

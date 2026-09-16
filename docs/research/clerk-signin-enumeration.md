# Clerk sign-in account enumeration — options and recommendation

- Issue: #1285 (child of map #1264)
- Date: 2026-09-16
- Scope: `packages/web` (`@clerk/clerk-react` v5.61.9, `clerkJSVersion="5.127.0"` pinned in `main.tsx`)

## Summary of the finding

Clerk ships an actual **built-in, dashboard-configurable "Strict" user-enumeration-protection mode** that changes server-side branching behavior (not just copy) — this is a materially better fit for this repo than either a localization-only fix or a bespoke custom flow, and it requires no SDK code changes to work with the existing `<SignIn/>` component, only a Dashboard setting plus dropping password as the first-factor strategy.

---

## (a) Can the string be changed via `localization`, and what's the exact key path?

**Yes.** The key lives at the top level of the `LocalizationResource` object, as a sibling of `signIn`, not nested under `signIn.start`:

```
unstable__errors.form_identifier_not_found
```

Verified directly against Clerk's own source, `packages/localizations/src/en-US.ts` in `github.com/clerk/javascript` (fetched raw at commit tip of `main`, 2026-09-16):

```ts
// line 1988
unstable__errors: {
  ...
  form_identifier_not_found: undefined,   // line 2003
  ...
  form_password_incorrect: undefined,     // line 2017
  form_password_or_identifier_incorrect: undefined,
  ...
}
```

Notes:
- The default en-US locale sets `form_identifier_not_found` to `undefined`. This means Clerk's default UI does **not** hardcode "Couldn't find your account." as a static localization string — it falls back to the `message`/`longMessage` returned by Clerk's Frontend API error object for that error code, unless the app supplies its own string for this key. Overriding it is exactly the documented mechanism (Clerk's own docs guide: "search the English localization file's `unstable__errors` object" to find overridable error keys — clerk.com/docs, localization/customization guidance surfaced via `clerk.com/docs/customization/localization`).
- `signIn.start` (line 1566 in the same file) only holds generic step copy (`title`, `subtitle`, button labels for the identifier-entry screen) — it is a different, unrelated part of the tree from the error-message keys. The ticket's guess of `signIn.start.subtitle` is **not** where this string lives.
- Usage shape, per Clerk's docs (`clerk.com/docs/customization/localization`):
  ```tsx
  <ClerkProvider
    localization={{
      unstable__errors: {
        form_identifier_not_found: 'If an account exists, you will be able to continue.',
      },
    }}
  >
  ```
- The `unstable__` prefix is Clerk's own naming — these error-message keys are explicitly marked as not yet a stabilized/versioned API surface, i.e., Clerk itself flags that the exact key names could change between releases without a major-version bump.

Sources: `github.com/clerk/javascript` → `packages/localizations/src/en-US.ts` (raw, fetched directly, lines cited above); `clerk.com/docs/customization/localization`.

## (b) Does changing the copy alone stop enumeration, or does branching behavior still leak it?

**No — copy alone does not stop enumeration, and Clerk's own docs say so explicitly.** This is confirmed by Clerk's dedicated documentation page and two changelog entries, not inference:

- `clerk.com/docs/guides/secure/user-enumeration-protection` states the underlying problem directly: "a malicious actor can exploit these error messages to check whether accounts exist for specific identifiers." Clerk's fix ships as a **Dashboard setting** (Protect → Rules → "User enumeration protection" → Manage), with two modes:
  - **Bulk protection**: rate-limits attempts, but "preserves normal sign-in experience and error feedback" — i.e., the identifier-not-found branch is still distinguishable from the password-step branch; it only slows down bulk probing, not one-off enumeration.
  - **Strict protection**: "Users won't receive feedback about whether their identifier matches an existing account" until identity *verification* — this changes actual control flow, not just text: sign-up attempts against an existing email don't send a new verification code (the existing owner just gets a notification), and sign-in against a non-existent identifier still **renders a verification screen and pretends to proceed**, without actually sending an SMS/email.
- The 2026-08-04 changelog (`clerk.com/changelog/2026-08-04-sign-in-or-up-strict-enumeration`) confirms this is a real behavioral branch fix, quoting Clerk's own description of the mechanism: "The visitor proves they control the address before Clerk commits to anything, so someone probing your sign-in page with addresses they don't own learns nothing either way." Concretely, under Strict mode every submitted identifier — real or not — is answered with the *same* verification-code screen; the account-exists-or-not branch is deferred until *after* the visitor supplies a valid code for that address, which is unforgeable by an outside prober.
- The earlier 2025-08-07 changelog (`clerk.com/changelog/2025-08-07-enumeration-protections`) is the original ship of this Dashboard feature (under "Attack Protection" at the time; the Rules page is the current location per the 2026 docs page), confirming it predates and is independent of any localization changes an app makes.

This directly answers the ticket's core question: **the identifier-first flow's branching (password step shown for known accounts vs. immediate error for unknown ones) is the actual leak, and it is a server-side/API-driven behavior Clerk controls — a `localization` override only changes what text is shown on the branch that already leaked the answer.** Relabeling "Couldn't find your account." to something generic does not change the fact that a known-good identifier still transitions the UI to a password prompt while an unknown one does not (or errors out at a different point) — that timing/state difference is itself the enumeration oracle, independent of wording.

**Important constraints on Strict mode** (same docs page):
- The Clerk instance must be in **Open access mode** (not Invite-only or Waitlist).
- **Password cannot be the starting/first-factor sign-in strategy** — Strict mode requires an OTP/code-based first factor instead, because a password field can be validated client-visibly (or the account can be probed by password-guessing timing) in a way a masked verification-code screen cannot.
- **Username identifiers are not supported** (verification requires a contactable identifier — email or phone).
- The default `<SignIn/>` component supports Strict protection's sign-in-or-up flow "without requiring code changes," per the 2026-08-04 changelog — but a custom flow must explicitly opt in via a `signUpIfMissing` parameter on `signIn.create()` (see (c)).

Sources: `clerk.com/docs/guides/secure/user-enumeration-protection`; `clerk.com/changelog/2026-08-04-sign-in-or-up-strict-enumeration`; `clerk.com/changelog/2025-08-07-enumeration-protections`.

## (c) What would a truly enumeration-safe custom flow cost, and does the SDK support it?

**Yes, `useSignIn` is a real, documented, headless API surface for building a fully custom sign-in UI**, confirmed via `clerk.com/docs/guides/development/custom-flows/authentication/email-password` and the hook reference at `clerk.com/docs/react/reference/hooks/use-sign-in` (also mirrored per-framework, e.g. `clerk.com/docs/nextjs/reference/hooks/use-sign-in`). Two API surfaces exist and matter here because this repo pins `@clerk/clerk-react ^5.61.9`:

1. **Legacy two-step API** (`SignIn.create()` → `SignIn.attemptFirstFactor()`), documented at `clerk.com/docs/guides/development/custom-flows/authentication/legacy/*`. This is the long-standing, stable API: `create({ identifier })` starts the attempt and returns a `SignIn` resource whose `status`/`supportedFirstFactors` tell the caller what's next; `attemptFirstFactor({ strategy: 'password', password })` completes it. Errors surface via `error.errors[0].code` (Clerk's own error-handling guide, `clerk.com/docs/nextjs/guides/development/custom-flows/error-handling`, shows the pattern `isClerkAPIResponseError(error)` + `error.errors.find(({ code }) => code === '...')`), and Clerk's own current localization source (`en-US.ts`, cited in (a)) confirms `form_identifier_not_found` and `form_password_incorrect` are live, documented error codes in this object shape today.
2. **Newer "Future" single-call API** (`useSignIn()` → `signIn.password({ emailAddress, password })`, via the `SignInFuture` object), documented at `clerk.com/docs/reference/javascript/sign-in-future` and the current (non-legacy) `clerk.com/docs/guides/development/custom-flows/authentication/email-password` guide. This example collects **identifier and password together in one form** (both `<input>`s in one `<form>`, submitted in one `signIn.password()` call), which is exactly the shape the ticket describes. Errors come back as a hook-level `errors.fields.identifier` / `errors.fields.password` object rather than a raw array. Whether v5.61.9 in this repo already exposes this Future API vs. only the legacy one could not be confirmed from docs text alone (the docs don't state a minimum version); this should be spot-checked against the installed package's type definitions before relying on `signIn.password()` (`node_modules/@clerk/clerk-react` or `@clerk/types`) rather than assumed from the docs.

**Either way, the granular error codes still come back from the API** — a custom flow does not by itself reduce what Clerk tells the client. The safety Product wants would come entirely from a client-side choice: catch both `form_identifier_not_found` and `form_password_incorrect` (and `form_password_or_identifier_incorrect`, which already exists as a key in Clerk's own error catalog, suggesting Clerk anticipated apps wanting exactly this consolidation) and render one generic message ("That email or password is incorrect.") regardless of which code arrived. This defeats the *copy-based* signal, but — per (b) — does **not** by itself defeat the *timing/branching* signal unless the custom flow is also built to make the identifier and password submission a single indistinguishable round trip (i.e., the UI must not visibly transition to "now enter your password" only for known accounts; it must always show one combined form and only reveal success/failure after both fields are submitted). Building that well means either:
   - using the legacy API but never rendering an intermediate "which factor" step (always prompt for both fields at once, call `create()` immediately followed by `attemptFirstFactor()`, and swallow the distinction between the two failure codes), or
   - using the new single-call `signIn.password()` Future API, which is already single-step by construction.

**Cost**: this replaces Clerk's maintained, accessible, continuously-updated hosted `<SignIn/>` UI (MFA, passkeys, SSO, magic links, device trust, bot protection, localized copy, dark mode, etc. all handled for free) with hand-rolled UI + state machine that must be kept in sync with Clerk's evolving first-factor/second-factor strategy set, correctly handle `supportedFirstFactors`, and independently re-implement anything else `<SignIn/>` gives for free (e.g., the `signUpIfMissing` "transfer" handling described in (b) also has to be re-implemented by hand in a custom flow — it's automatic in `<SignIn/>`). This is real, ongoing maintenance cost, not a one-time patch.

Sources: `clerk.com/docs/guides/development/custom-flows/authentication/email-password`; `clerk.com/docs/reference/javascript/sign-in-future`; `clerk.com/docs/react/reference/hooks/use-sign-in`; `clerk.com/docs/nextjs/guides/development/custom-flows/error-handling`; `clerk.com/docs/guides/development/custom-flows/authentication/legacy/email-password-mfa`; `github.com/clerk/javascript` `packages/localizations/src/en-US.ts` (for the live error-code catalog).

## (d) Concrete recommendation for this repo

**Repo state today** (all verified in this worktree):
- `packages/web/src/main.tsx:52-64` mounts the one and only `<ClerkProvider>` in the app:
  ```tsx
  <ClerkProvider
    publishableKey={CLERK_PUBLISHABLE_KEY}
    clerkJSVersion="5.127.0"
    signInUrl="/login"
    signUpUrl="/signup"
    afterSignOutUrl="/login"
  >
  ```
  No `localization` prop is present.
- `packages/web/src/components/auth/LoginPage.tsx:1,65-74` renders Clerk's default hosted `<SignIn signUpUrl="/signup" fallbackRedirectUrl={redirectTarget} appearance={{...}} />` — the stock multi-step identifier-then-password flow, no custom flow, no `useSignIn` usage anywhere in production code (`useSignIn` only appears in test-file grep hits, not real code).
- `packages/web/src/dev/clerk-dev-shim.tsx` is a dev-only Vite alias (active only under `VITE_AUTH_MODE=dev`) that no-ops `ClerkProvider` and renders `<SignIn>`/`<SignUp>` as static placeholder `<div>`s — it never reaches Clerk's real API, so it is unaffected by any of the changes below and doesn't need modification for this issue.
- `packages/web/src/components/auth/P0-029.ClerkProvider.test.tsx` fully mocks `@clerk/clerk-react` (`vi.mock`) and only asserts that `ClerkProvider` renders `children`, that `<SignIn>`/`<SignUp>` render on the right routes, that sign-out calls `signOut({ redirectUrl: '/login' })`, and that `main.tsx` requires `VITE_CLERK_PUBLISHABLE_KEY`. It asserts nothing about `localization`, so adding a `localization` prop to the `main.tsx` call site will not break this test.

**Recommendation, in order of cost vs. benefit:**

1. **Cheapest, but incomplete on its own** — add a `localization` override to the existing `<ClerkProvider>` in `packages/web/src/main.tsx:52`:
   ```tsx
   <ClerkProvider
     publishableKey={CLERK_PUBLISHABLE_KEY}
     clerkJSVersion="5.127.0"
     signInUrl="/login"
     signUpUrl="/signup"
     afterSignOutUrl="/login"
     localization={{
       unstable__errors: {
         form_identifier_not_found: 'Check your email and password and try again.',
       },
     }}
   >
   ```
   This is a one-file, low-risk change (no test breakage per above) and removes the literal copy leak. **It does not stop enumeration** per (b): a known account still visibly proceeds to a password-entry step while an unknown one still errors immediately, so a prober can still tell accounts apart by *when* the error appears, independent of its text.

2. **Recommended primary fix, moderate cost, actually closes the branching leak** — enable Clerk's built-in **Strict user enumeration protection** in the Clerk Dashboard (Protect → Rules → "User enumeration protection" → Manage → Strict), per (b). For this repo specifically that requires:
   - Confirming the Clerk instance is in **Open access mode** (not Invite-only/Waitlist) — needs verification against current Dashboard config, not visible from the repo.
   - Removing password as the sign-in **first factor** in the Dashboard's authentication-strategy config (Strict mode requires an OTP/code first factor instead). This is a product-facing UX change (users would enter email/phone → get a code, rather than email → password) and needs sign-off beyond this repo's code.
   - No code change is required in `LoginPage.tsx` for the default `<SignIn/>` component to pick this up, per the 2026-08-04 changelog ("without requiring code changes or configuration updates" on the component side) — the Dashboard setting plus the first-factor change is the entire lift for this repo's current stock-`<SignIn/>` setup.
   - This is the option that actually fixes the underlying issue #1285 is about (branching/timing enumeration), not just the visible string.

3. **Most expensive, only worth it if product explicitly needs a single combined email+password form** — replace `<SignIn/>` in `LoginPage.tsx` with a custom flow built on `useSignIn` (either the legacy `create()`/`attemptFirstFactor()` pair or, if the installed `@clerk/clerk-react@^5.61.9` exposes it, the newer `signIn.password()` Future API), collecting identifier+password in one form and mapping both `form_identifier_not_found` and `form_password_incorrect` (and `form_password_or_identifier_incorrect`) to one generic client-side message. This closes the *copy* leak the same as option 1, and can close the *timing* leak too **only if** the UI is built to never visibly branch on account existence before submission — which in practice reproduces much of what option 2 gets for free from Clerk, plus ongoing maintenance cost of a hand-rolled auth UI (MFA, passkeys, `signUpIfMissing` transfer handling, etc. all become this repo's problem). Given option 2 exists and is documented as requiring no `<SignIn/>` code changes, this option should only be chosen if Strict mode's constraints (Open access mode, no password-first, no username identifiers) are unacceptable for product reasons.

**Bottom line**: do (1) as a quick, safe copy fix if desired, but treat (2) — the Dashboard's Strict enumeration-protection setting — as the actual fix for issue #1285, since it is Clerk's own documented, purpose-built answer to this exact problem and requires no `<SignIn/>` rewrite in this repo. Reserve (3) for if product later wants a bespoke single-form login UX for reasons unrelated to enumeration.

---

## Sources cited

- `github.com/clerk/javascript` → `packages/localizations/src/en-US.ts` (raw file fetched directly from `main` on 2026-09-16; exact line numbers cited above are from that fetch and will drift as the file changes upstream).
- `clerk.com/docs/customization/localization`
- `clerk.com/docs/guides/secure/user-enumeration-protection`
- `clerk.com/changelog/2026-08-04-sign-in-or-up-strict-enumeration`
- `clerk.com/changelog/2025-08-07-enumeration-protections`
- `clerk.com/docs/guides/development/custom-flows/authentication/email-password`
- `clerk.com/docs/guides/development/custom-flows/authentication/sign-in-or-up`
- `clerk.com/docs/guides/development/custom-flows/authentication/legacy/email-password-mfa`
- `clerk.com/docs/guides/development/custom-flows/authentication/legacy/sign-in-or-up`
- `clerk.com/docs/reference/javascript/sign-in-future`
- `clerk.com/docs/react/reference/hooks/use-sign-in`
- `clerk.com/docs/nextjs/guides/development/custom-flows/error-handling`
- `clerk.com/docs/custom-flows/overview`
- Repo files (this worktree, `research/clerk-signin-enumeration` branch): `packages/web/package.json`, `packages/web/src/main.tsx`, `packages/web/src/components/auth/LoginPage.tsx`, `packages/web/src/components/auth/SignupPage.tsx`, `packages/web/src/dev/clerk-dev-shim.tsx`, `packages/web/src/components/auth/P0-029.ClerkProvider.test.tsx`

## Caveats on sourcing

Live network access to `clerk.com` and raw GitHub content was available during this research (verified via direct `curl` and fetch tool calls). Docs pages were fetched through a summarizing fetch tool rather than read as raw HTML/markdown; where a fetch returned "not present in the provided content" (e.g., `clerk.com/docs/nextjs/guides/development/custom-flows/error-handling` did not surface `form_identifier_not_found`/`form_password_incorrect` in the excerpt it returned), that specific negative should be read as "not found in this tool's extracted excerpt," not as confirmed absence from Clerk's full docs — the error-code catalog itself was instead confirmed directly and authoritatively from Clerk's own source file (`en-US.ts`), which is a stronger primary source than a docs-page excerpt. The GitHub code-search API (which would have let us locate exactly where `clerk-js`'s UI reads `unstable__errors` keys at runtime) returned 401 Unauthorized (unauthenticated code search is not permitted by GitHub's API) and was not pursued further since the localization source file already gives a first-party, line-cited answer to (a).

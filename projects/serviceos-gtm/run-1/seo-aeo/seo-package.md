# SEO / AEO Package — Rivet ServiceOS marketing site

Deliverable summary for the SEO/AEO integration pass on
`projects/serviceos-gtm/run-1/site/` (Next.js 15 App Router). Brand reconciled
to **Rivet** (company/site) + **ServiceOS** (product); formal entity **Rivet
ServiceOS**. All checks green.

## Verification results

| Check | Command | Result |
|---|---|---|
| Production build | `npm run build` | ✅ clean — 27 routes, 0 errors |
| Unit tests | `npm test` | ✅ 122 passed / 13 files (was 90; +32) |
| Typecheck | `npx tsc --noEmit` | ✅ clean |
| Schema + link validation | `npm run validate:schema` | ✅ passed — 57 JSON-LD blocks across 21 pages; 22 routes link-checked |

`validate:schema` builds with `VERCEL_ENV=production`, reads every generated
HTML page from `.next/server/app`, JSON-parses all `<script type="application/
ld+json">` blocks, and asserts required fields per type, **no aggregateRating /
review anywhere**, absolute URLs where required, expected types present per
page, plus an internal-link check (every `href="/…"` maps to a real route) and
`llms.txt` / `robots.txt` / `sitemap.xml` body checks.

## Structured data (JSON-LD) per page

| Page | Schema types |
|---|---|
| `/` (home) | Organization, SoftwareApplication |
| `/pricing` | Organization, SoftwareApplication, FAQPage, BreadcrumbList |
| `/faq` | Organization, FAQPage, BreadcrumbList |
| `/how-it-works` | Organization, BreadcrumbList |
| `/resources` | Organization, BreadcrumbList |
| `/vs-jobber` | Organization, FAQPage, BreadcrumbList |
| `/vs-housecall-pro` | Organization, FAQPage, BreadcrumbList |
| `/resources/[slug]` ×8 | Organization, Article, BreadcrumbList, FAQPage |
| all other pages | Organization (site-wide, from layout) |

- **Organization** is rendered once in the root layout (name `Rivet`,
  alternateName `Rivet ServiceOS`, absolute `url` + `logo`, `sameAs` omitted —
  no real profiles).
- **SoftwareApplication** (`name: "Rivet ServiceOS"`, `applicationCategory:
  BusinessApplication`, `operatingSystem: Web`) carries the 3 real tiers as an
  `AggregateOffer` → `Offer[]` each with `price` / `priceCurrency: USD` / `url:
  /pricing`. **No `aggregateRating`** (hard rule — no real reviews).
- **FAQPage** items are generated from the same data that renders the visible
  Q&A on each page, so JSON-LD ↔ rendered text stay in exact parity. Article
  FAQ answers are run through `plainText()` so markdown links collapse to their
  visible label (Google parity). One FAQPage per page.
- **BreadcrumbList** uses ordered `itemListElement` with absolute item URLs
  (Home → Section → Page for articles; Home → Page for subpages).
- **Article** carries headline / description / datePublished / author /
  publisher / absolute `mainEntityOfPage`.

All builders live in `src/lib/schema.ts` (unit-tested in `schema.test.ts`).

## Per-page metadata + Open Graph

- Title template reconciled to **`<Page> — Rivet`** (`layout.tsx`); pages whose
  title already reads as a complete phrase (`vs-*`, articles) use
  `titleAbsolute` to avoid a doubled brand suffix. **All rendered titles ≤ 60
  chars; all descriptions ≤ 155.**
- Every page: unique keyword-targeted title, answer-first description, canonical
  via `metadataBase` + `alternates.canonical`, `openGraph`
  (title/description/type/url/siteName/images) + `twitter` `summary_large_image`.
- **OG image**: `public/og.png` (1200×630) generated from brand assets by
  `scripts/generate-og.py` (cairosvg) — gunmetal field, dark logo lockup, locked
  tagline "You handle the work. We handle the business.", Hot Rivet seam, support
  line. Wired site-wide via `OG_IMAGE` in `metadata.ts`; articles reuse it.

## Entity definition (one sentence, used across surfaces)

> Rivet ServiceOS is an AI back office for one-to-three-truck HVAC and plumbing
> companies that answers the phone, books jobs, sends estimates and invoices by
> voice, and never acts without the owner's approval.

Rendered in the footer, the Organization/SoftwareApplication descriptions, and
the `llms.txt` blockquote.

## llms.txt

`app/llms.txt/route.ts` — full answer-engine briefing (no placeholders):
H1 `# Rivet ServiceOS`, one-sentence definition blockquote, **Key facts**
(pricing $299/$499/$799, 14-day trial, HVAC+plumbing, human-approval trust
model), an honest **"does NOT do yet"** list, a **Pages** section (every page,
absolute URLs, one-line descriptions), all 8 resource articles, **8 liftable FAQ
highlights**, and a **Comparison summary** (Jobber / Housecall Pro / ServiceTitan,
each with the honest "verify current" qualifier). Answer-first, no marketing
fluff. Covered by `llms.txt/route.test.ts`.

## Technical SEO

- **sitemap.ts** — all public pages incl. `/vs-housecall-pro` (the known gap),
  both legal pages, `/signup`; excludes `/signup/demo-checkout`,
  `/nurture-preview`, `/go-live-pending`, `/signup/success`, `/api/*`. Covered by
  `sitemap.test.ts`.
- **robots.ts** — off-production disallow-all preserved; production allows `/`
  and disallows `/api/`, `/nurture-preview`, `/signup/demo-checkout`,
  `/go-live-pending`, and emits `Sitemap:` + `host`.
- **Images**: the only `<img>` elements (Header/Footer logos) carry `alt`; the
  home `<video>` has fallback text and a poster. No missing alts.
- **H1s**: exactly one per page (demo-checkout's h1 lives in its client
  component). No duplicates.
- **Internal links**: validated — every internal `href` resolves to a generated
  route.

## Navigation / integration fixes

- Header nav: `vs Jobber` → **`Compare`** (→ `/vs-jobber`).
- Footer: new **Compare** column linking both `/vs-jobber` and
  `/vs-housecall-pro`; grid widened to 5 columns.
- Cross-links added between the two `vs` pages.
- `/vs-housecall-pro` added to sitemap + nav (was orphaned).

## Brand / hygiene

- `SITE_NAME` → `Rivet` (was `ServiceOS` + COPY-TODO).
- All COPY-TODO / placeholder copy resolved. Remaining bare "ServiceOS" strings
  are legitimate product-name usages or code comments (verified).
- Dead code removed: unused `Plan.tagline` / `Plan.features` placeholder fields
  (never read — `PricingCards` owns the feature list) deleted from `plans.ts`.

## AEO coverage

**24 / 25** research questions answered on live pages (96%). Added Q14 (discount/
negotiation guardrail) and Q19 (Google reviews) to `/faq` this pass — both
shipped capabilities that were thin. FAQPage JSON-LD regenerates from the same
`FAQ_GROUPS` data, so it stays in sync. Full map: `seo-aeo/aeo-coverage.md`.

**One flagged gap — Q10** (hours/week on admin work): not force-fit into `/faq`
because its honest answer needs the Forbes/Time Etc ~36% survey citation, which
would break FAQ-answer↔JSON-LD parity and the "no uncited stat" honesty rule.
Recommended home: a cited section in a resource article. Not a shipped-claim
gap — a market-stat gap.

## New / changed files (highlights)

- New: `src/lib/schema.ts`, `scripts/validate-schema.mjs`, `scripts/generate-og.py`,
  `public/og.png`, tests (`schema.test.ts`, `site.test.ts`, `sitemap.test.ts`,
  `llms.txt/route.test.ts`), `seo-aeo/aeo-coverage.md`, `seo-aeo/seo-package.md`.
- Changed: `layout.tsx`, `metadata.ts`, `site.ts`, `plans.ts`, `robots.ts`,
  `sitemap.ts`, `llms.txt/route.ts`, `Footer.tsx`, `PricingCards.tsx`,
  `page.tsx` (home), `pricing`, `faq`, `how-it-works`, `resources`,
  `resources/[slug]`, `vs-jobber`, `vs-housecall-pro`, and metadata titles on
  signup/success/demo-checkout/legal pages. `package.json` (+`validate:schema`).

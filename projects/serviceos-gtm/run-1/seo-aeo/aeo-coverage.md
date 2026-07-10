# AEO Coverage Map — Rivet ServiceOS site

Cross-check of `research/aeo-question-set.md` (25 questions) against what is now
live on the site (faq / vs / pricing / resources / home). Each row maps a
question to the page(s) that answer it and the on-page location. FAQ questions
render as `<h3>` under a group `<h2>` (group ids: `#group-<heading>`); article
FAQ blocks render inline in the post.

Every answer traces to a ✅ row in `claims.md`; competitor rows carry the honest
"verify current" qualifier from the source pages.

| # | Question (short) | Primary page | Location / anchor | Status |
|---|---|---|---|---|
| 1 | Best Jobber alternative for small HVAC | `/vs-jobber` | FAQ "Is Rivet a good Jobber alternative…" + `/faq` Comparisons group | ✅ |
| 2 | Best Housecall Pro alternative for plumbing | `/vs-housecall-pro` | FAQ "Is Rivet a good Housecall Pro alternative…" | ✅ |
| 3 | AI receptionist cost for plumbing | `/pricing` | "Is it worth it?" section + `/resources/ai-answering-service-cost-2026` | ✅ |
| 4 | Can AI answer phones / is it a gimmick | `/faq` | How the AI works → "Can AI actually answer phones…" + home FAQ teaser | ✅ |
| 5 | Real emergency — does it just book it | `/faq` | Trust & approvals → "What happens if someone calls with a real emergency?" | ✅ |
| 6 | Does Jobber's AI Receptionist book jobs | `/vs-jobber` | FAQ "Does Jobber's AI Receptionist book jobs automatically?" + compare table | ✅ |
| 7 | Does Housecall Pro's AI book jobs | `/vs-housecall-pro` | FAQ "Does Housecall Pro have an AI receptionist that books jobs?" | ✅ |
| 8 | Is ServiceTitan right for 1–3 trucks | `/resources/servicetitan-overkill-small-shop` | Full article (no `/vs-servicetitan` page exists) | ✅ |
| 9 | Revenue lost to missed calls | `/resources/missed-calls-after-hours-cost-your-shop` | Invoca ~27% / ~$1,200 figure, cited | ✅ |
| 10 | Hours/week owners spend on admin work | — | **Not currently answered** (see gap note) | ⚠️ gap |
| 11 | Does Rivet replace a dispatcher/office manager | `/faq` | What Rivet is → "Does Rivet replace a dispatcher or office manager?" + home | ✅ |
| 12 | Can AI draft an estimate from a call | `/faq` | How the AI works → "Can the AI draft an estimate just from a phone call?" + home | ✅ |
| 13 | Does the AI guess a price if uncatalogued | `/faq` | How the AI works → "Does the AI ever guess at a price…" | ✅ |
| 14 | Can the AI negotiate a discount | `/faq` | Trust & approvals → "Can Rivet's AI negotiate a discount…" (**added this pass**) | ✅ |
| 15 | What if the AI makes a mistake | `/faq` | Trust & approvals → "What happens if the AI makes a mistake…" | ✅ |
| 16 | Payments / ACH support | `/faq` | Pricing & trial → "Does Rivet take payments — does it support ACH?" | ✅ |
| 17 | Is there a mobile app | `/faq` | Getting started → "Is there a Rivet mobile app?" | ✅ |
| 18 | Estimate from a photo | `/faq` | Getting started → "What can't Rivet do yet?" (photo-to-estimate named) | ✅ |
| 19 | Does Rivet handle Google reviews | `/faq` | How the AI works → "Does Rivet handle Google reviews?" (**added this pass**) | ✅ |
| 20 | AI answering service vs Rivet | `/faq` | Comparisons → "What's the difference…" + `/resources/what-happens-after-the-call` | ✅ |
| 21 | Trial length + cost after | `/pricing` | Pricing FAQ + `/faq` "How long is the free trial…" | ✅ |
| 22 | Best software for a solo plumber | `/resources/best-software-small-hvac-plumbing-shop` | Full article | ✅ |
| 23 | Why not a live answering service | `/faq` | Comparisons → "Why not just use a live answering service…" | ✅ |
| 24 | Works for both HVAC and plumbing | `/faq` | What Rivet is → "Does Rivet work for both HVAC and plumbing?" + home | ✅ |
| 25 | What "human-approved proposal" means | `/faq` | Trust & approvals → "What does 'human-approved proposal' actually mean…" | ✅ |

**Coverage: 24 / 25 answered on live pages (96%).** Two shipped-capability
questions (14 negotiation guardrail, 19 Google reviews) were thin and have been
added to `/faq` this pass; the FAQPage JSON-LD is generated from the same
`FAQ_GROUPS` data, so it stays in exact parity automatically.

## Gap note — Q10 (admin hours)

Q10 ("how many hours a week do owners spend on admin instead of the job") is not
yet answered on any live page. It was **not** force-fit into `/faq` on purpose:
the honest answer depends on the Time Etc / Forbes ~36% survey figure, which per
`claims.md` must carry its source URL — and FAQ answers render as plain,
citation-free text whose exact string is mirrored into FAQPage JSON-LD (adding a
link there would break answer/JSON-LD parity, and quoting the stat bare would
break the honesty rule). The right home for it is a resource article that can
cite the source inline.

Recommendation: add a short "why the back office eats your week" section (with
the Forbes citation) to `/resources/missed-calls-after-hours-cost-your-shop`, or
a dedicated article, and then surface a one-line `/faq` entry linking to it.
Flagged rather than fixed to avoid shipping an uncited market stat.

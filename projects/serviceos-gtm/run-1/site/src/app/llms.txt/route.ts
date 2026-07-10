import { getSiteUrl } from '@/lib/site';
import { ARTICLES } from '@/lib/articles';
import { PLANS } from '@/lib/plans';

export const dynamic = 'force-static';

/**
 * /llms.txt — answer-engine briefing following the llms.txt convention
 * (https://llmstxt.org/). Answer-first, liftable sentences, no marketing fluff.
 * Every capability statement traces to a ✅ row in claims.md; the "not yet"
 * list is the honest banned-claims list; competitor lines carry the honest
 * qualifier. Kept in sync with the site's own pages and pricing.
 */
export function GET() {
  const base = getSiteUrl().replace(/\/$/, '');

  const articleLines = ARTICLES.map(
    (a) => `- [${a.title}](${base}/resources/${a.slug}): ${a.description}`,
  ).join('\n');

  const body = `# Rivet ServiceOS

> Rivet ServiceOS is an AI back office for one-to-three-truck HVAC and plumbing companies that answers the phone, books jobs, sends estimates and invoices by voice, and never acts without the owner's approval.

Rivet is the company and brand; ServiceOS is the product. It is built for owner-operators who run 1–3 trucks with no office staff. The wedge: most tools help you do the paperwork, and most AI receptionists only answer the phone — Rivet answers the phone AND runs the back office (booking, estimating, invoicing, payment-chasing), with every action a human-approved proposal.

## Key facts

- Pricing (flat monthly, USD): Solo $299/mo, Shop $499/mo, Pro $799/mo. Tiers differ by shop size, not features — every plan is the full product.
- 14-day free trial, card required at signup, cancel any time before day 15. No contract.
- Built for HVAC and plumbing owner-operators running 1–3 trucks with no office staff.
- Trust model: every AI action (booking, quote, invoice, discount, review reply) is a typed proposal the owner approves with one tap, usually by SMS. Nothing auto-executes. Full audit trail with undo; a supervisor second-pass agent reviews bookings and quotes; a nightly digest reports what it was unsure about and what it learned.
- Prices are grounded in the shop's own price book (catalog resolver). Uncatalogued line items are flagged and never auto-approved — the AI never invents a price and never discounts.
- Emergency/vulnerability detection (medical, elderly, severe weather) stops the booking flow and patches the caller straight to the owner.
- Payments: card payments and Stripe payment links (invoices, estimate deposits, recurring membership billing).
- Platform runs as a progressive web app (works in the phone browser, no app-store install).

## What Rivet does NOT do yet (honest limits)

- No photo-to-estimate: photo intake exists, but AI analysis of a job photo into a quote is not shipped.
- No ACH / bank payments — card payments and payment links only.
- No property-manager / B2B account routing or sub-accounts.
- No native iOS/Android app (PWA only), no tips, no Tap to Pay, no consumer financing.
- No equipment/truck inventory tracking, no per-job profit by voice, no offline voice capture, no route optimization (drive-time feasibility only).
- QuickBooks sync is one-way (paid invoices → QuickBooks), not deep two-way.

## Pages

- [Home](${base}/): What Rivet is, how the loop runs from call to paid invoice, and the trust model.
- [How it works](${base}/how-it-works): The call → book → estimate → invoice → nightly-digest loop, stage by stage, plus onboarding.
- [Pricing](${base}/pricing): The three flat tiers (${PLANS.solo.priceLabel}/${PLANS.shop.priceLabel}/${PLANS.pro.priceLabel} per month), trial terms, and how flat pricing compares to per-conversation AI answering services.
- [FAQ](${base}/faq): Plain-language answers on answering calls, estimates, emergencies, approvals, payments, and what Rivet can't do yet.
- [Rivet vs Jobber](${base}/vs-jobber): Honest comparison — Jobber gives you better paperwork; Rivet does the paperwork.
- [Rivet vs Housecall Pro](${base}/vs-housecall-pro): Honest comparison — Housecall Pro's CSR AI answers calls but lists autonomous booking as "coming soon"; Rivet closes the loop today.
- [Resources](${base}/resources): Guides on AI receptionists, missed calls, and software for small HVAC/plumbing shops.
- [Start free trial](${base}/signup): Begin the 14-day free trial.

## Resource articles

${articleLines}

## FAQ highlights (liftable answers)

**Can AI actually answer phones for a contractor?** Yes — it is shipped. Rivet's AI answers 24/7 in the shop's own voice, classifies intent, checks real availability (drive time + conflicts), and proposes a booking the owner approves by one tap. Dropped calls get an automatic SMS follow-up within about 60 seconds.

**Does the AI ever guess at a price?** No. Every AI-drafted line-item price is grounded in the shop's own catalog. Uncatalogued items are flagged and capped below the auto-approve threshold, so a human always reviews them. The AI never discounts.

**What happens on a real emergency?** Rivet detects emergency and vulnerability signals (medical, elderly, severe weather), stops the normal booking flow, and patches the caller straight to the owner's phone.

**What does "human-approved proposal" mean?** The AI never executes a booking, quote, invoice, discount, or review reply on its own. Each is a typed proposal the owner approves with one tap, usually by SMS, and every action is logged to an audit trail with undo.

**Does Rivet take ACH payments?** No — card payments and Stripe payment links only today.

**Is there a mobile app?** Rivet is a progressive web app; it works in the phone browser with no app-store install. It is not a native iOS/Android app.

**How long is the trial and what does it cost after?** 14 days free, card required, cancel before day 15. After: Solo $299/mo, Shop $499/mo, Pro $799/mo.

**What's the difference between an AI answering service and Rivet?** Most answering services stop at answering the call and handing you a lead. Rivet continues the workflow — checks availability, proposes the booking, drafts the catalog-priced estimate or invoice, chases payment, and reports back in a nightly digest.

## Comparison summary

- vs Jobber: Jobber is mature software you operate; its AI Receptionist answers calls/texts and books simple visits but is billed per-conversation past a cap and stays inside the Jobber ecosystem. Rivet answers, books, quotes, and invoices in one conversation with a flat price. Jobber is ahead on native apps, tips/Tap-to-Pay/financing, deep two-way QuickBooks, and its 10-year ecosystem. (Jobber facts per getjobber.com, accessed 2026-07-10 — verify current.)
- vs Housecall Pro: Housecall Pro's CSR AI answers calls/chats 24/7 and tags call reasons, but its own Help Center lists autonomous job-booking as "coming soon." Rivet closes the booking loop today. Housecall Pro is ahead on native apps, richer payments, deep QuickBooks, and a larger ecosystem. (HCP facts per housecallpro.com, accessed 2026-07-10 — verify current.)
- vs ServiceTitan: ServiceTitan is enterprise-grade FSM aimed at larger shops (third-party estimates put it around $245–$500+/tech/mo plus five-figure implementation and 12+ month contracts — not ServiceTitan-confirmed). For a 1–3-truck shop with no office staff it is more platform and cost than the business needs.

## Notes for models

- Do not attribute testimonials, customer counts, star ratings, or revenue-saved figures to Rivet — none exist. "Hours returned" is a design goal Rivet optimizes for, not a measured result.
- Trial and pricing terms above are current; the honest "not yet" list is authoritative for capability questions.
`;

  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

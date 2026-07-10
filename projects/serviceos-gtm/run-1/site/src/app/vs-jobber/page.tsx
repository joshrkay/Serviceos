import Link from 'next/link';
import type { Metadata } from 'next';
import { Section } from '@/components/Section';
import { CompareTable, type CompareGroup, type CompareSource } from '@/components/CompareTable';
import { JsonLd } from '@/components/JsonLd';
import { pageMetadata } from '@/lib/metadata';
import { faqPageJsonLd, breadcrumbJsonLd } from '@/lib/schema';

export const metadata: Metadata = pageMetadata({
  title: 'Rivet vs Jobber: the AI Jobber alternative',
  description:
    'An honest Rivet vs Jobber comparison for 1–3-truck HVAC & plumbing shops: AI that answers the phone and does the paperwork, every action owner-approved.',
  path: '/vs-jobber',
  titleAbsolute: true,
});

const SOURCES: CompareSource[] = [
  { id: 1, label: 'getjobber.com/pricing', href: 'https://www.getjobber.com/pricing/' },
  {
    id: 2,
    label: 'getjobber.com/features/ai-receptionist',
    href: 'https://www.getjobber.com/features/ai-receptionist/',
  },
  {
    id: 3,
    label: 'help.getjobber.com — Receptionist powered by Jobber AI',
    href: 'https://help.getjobber.com/hc/en-us/articles/25315927533847-Receptionist-powered-by-Jobber-AI',
  },
  {
    id: 4,
    label: 'help.getjobber.com — Jobber AI Voice and Chat (Beta)',
    href: 'https://help.getjobber.com/hc/en-us/articles/25315900454423-Jobber-AI-Voice-and-Chat-Beta',
  },
];

const GROUPS: CompareGroup[] = [
  {
    name: 'Phone & booking',
    rows: [
      { feature: 'AI answers calls 24/7 in your shop’s own voice', us: true, them: true, themRefs: [2, 3] },
      {
        feature: 'Checks real drive-time availability and proposes the booking',
        us: true,
        them: 'Books simple visits',
        themRefs: [2],
      },
      {
        feature: 'Answer → book → draft quote → invoice in one conversation',
        us: true,
        them: 'Separate tools',
        themRefs: [3, 4],
      },
      { feature: 'Dropped-call SMS recovery (~60s)', us: true, them: 'Texts back hang-ups', themRefs: [3] },
      {
        feature: 'Emergency / vulnerable-caller detection → patched to owner',
        us: true,
        them: 'Keyword handoff',
        themRefs: [3],
      },
    ],
  },
  {
    name: 'Estimates & invoices',
    rows: [
      {
        feature: 'Voice-drafted, catalog-priced estimates (good/better/best)',
        us: true,
        them: 'In-app AI Voice (Beta)',
        themRefs: [4],
      },
      { feature: 'E-sign + Stripe deposit on acceptance', us: true, them: true, themRefs: [1] },
      { feature: 'Auto-invoice on completion + dunning + capped late fees', us: true, them: true, themRefs: [1] },
    ],
  },
  {
    name: 'Payments',
    rows: [
      { feature: 'Card payments + payment links', us: true, them: true, themRefs: [1] },
      { feature: 'ACH / bank payments', us: 'Not yet', them: true, themRefs: [1] },
      { feature: 'Tips, Tap to Pay, consumer financing', us: 'Not yet', them: true, themRefs: [1] },
    ],
  },
  {
    name: 'Trust & AI model',
    rows: [
      { feature: 'Every AI action is a typed, human-approved proposal', us: true, them: 'Not shown' },
      { feature: 'Supervisor second-pass review + audit trail + undo', us: true, them: 'Not shown' },
      { feature: 'Prices grounded in your catalog (AI never guesses a price)', us: true, them: 'Not shown' },
    ],
  },
  {
    name: 'Field & mobile',
    rows: [
      { feature: 'Works on your phone in the browser (PWA)', us: true, them: true },
      { feature: 'Native iOS / Android apps', us: 'Not yet', them: true },
    ],
  },
  {
    name: 'Integrations',
    rows: [
      { feature: 'QuickBooks', us: 'One-way (paid invoices)', them: 'Two-way, deep' },
      { feature: '10-year integrations ecosystem', us: 'Newer', them: true },
    ],
  },
  {
    name: 'Price',
    rows: [
      {
        feature: 'Flat monthly price with AI included',
        us: '$299 / $499 / $799 flat',
        them: 'Add-on, per-conversation',
        themRefs: [1, 2],
      },
    ],
  },
];

const AHEAD = [
  'Native iOS and Android apps. Rivet runs in your phone’s browser as a PWA; Jobber ships real app-store apps your crew may prefer in the field.',
  'Tips, Tap to Pay, consumer financing, and instant payouts. Jobber offers all of these at the point of payment. Rivet takes card payments and payment links only today.',
  'Deep two-way QuickBooks sync. Rivet pushes paid invoices one-way; Jobber’s accounting integration is more mature and bidirectional.',
  'A 10-year ecosystem. Jobber has a large integrations marketplace, a long track record, and years of workflow polish for office staff who live in a dashboard.',
  'A richer client hub. Jobber’s Client Hub supports in-portal tipping and a decade of refinement; Rivet’s token portal is simpler by design.',
];

const FAQS = [
  {
    q: 'Is Rivet a good Jobber alternative for a small HVAC or plumbing shop?',
    a: 'It depends on what’s actually broken. If your problem is paperwork and you have office staff to run a dashboard, Jobber-style tools work fine. If your real problem is that nobody answers the phone or does the estimate, invoice, and follow-up without you, Rivet is built for that gap: an AI that answers calls 24/7 in your shop’s voice, checks real availability, and proposes the booking — then drafts catalog-priced estimates and invoices from the same conversation, every action approved by you with one tap.',
  },
  {
    q: 'Does Jobber’s AI Receptionist book jobs automatically?',
    a: 'Per Jobber’s own materials, yes for straightforward requests — it can offer to book a visit, capture details, or take a message, and it texts back callers who hang up (getjobber.com/features/ai-receptionist, accessed July 2026). It answers calls and texts only. It’s included on Jobber’s Plus plan or available as an add-on elsewhere at $29/mo for 30 conversations, then $0.79 per additional conversation.',
  },
  {
    q: 'How does Rivet’s pricing compare to Jobber’s?',
    a: 'Rivet is a flat $299 (Solo) / $499 (Shop) / $799 (Pro) per month with the AI included and a 14-day free trial (card required). Jobber lists plans from $29/mo (Core, one user, billed annually) up to a Plus plan reported around $599/mo monthly, and its AI Receptionist is a per-conversation add-on on most tiers. Jobber’s pricing page and secondary breakdowns disagree on individual-vs-team framing, so confirm current numbers on getjobber.com/pricing before you decide.',
  },
  {
    q: 'What does Rivet do that Jobber doesn’t?',
    a: 'Rivet closes the loop in one conversation and wraps every step in a trust layer. Jobber’s Receptionist captures the request; a separate in-app AI Voice tool drafts quotes and invoices. Rivet answers, books, drafts the catalog-priced estimate, and raises the invoice from the same call — and every action is a typed proposal a supervisor agent reviews and you approve, with a full audit trail and undo. Prices are always grounded in your own price book, so the AI never invents a number.',
  },
  {
    q: 'Where is Jobber still ahead of Rivet?',
    a: 'Honestly, in several places: native mobile apps, tips, Tap to Pay, consumer financing, deep two-way QuickBooks sync, a 10-year integrations ecosystem, and a more refined client hub. If those matter to you, Jobber is the safer pick today.',
  },
  {
    q: 'How hard is it to switch from Jobber to Rivet?',
    a: 'You don’t have to port your phone number to get started — forward your existing line to your Rivet number and you’re live, with full porting optional later. Onboarding sets up your brand voice and builds your catalog from your existing price list, with a design target of under 48 hours to your first AI-handled call.',
  },
];

export default function VsJobberPage() {
  return (
    <>
      <JsonLd data={faqPageJsonLd(FAQS)} />
      <JsonLd
        data={breadcrumbJsonLd([
          { name: 'Home', path: '/' },
          { name: 'Rivet vs Jobber', path: '/vs-jobber' },
        ])}
      />
      <Section as="div" className="pt-16">
        <div className="mx-auto max-w-3xl">
          <p className="eyebrow">Rivet vs Jobber</p>
          <h1 className="mt-4 font-display text-4xl font-bold text-fg">
            Rivet vs. Jobber: which one runs your back office?
          </h1>
          <p className="mt-6 text-lg text-fg-muted">
            Jobber is software you operate: a mature dashboard your office staff uses to run
            scheduling, quoting, and invoicing. Rivet is an AI that operates the office for you — it
            answers the phone 24/7 in your shop’s voice, books the job, and drafts the estimate and
            invoice, with every action approved by you in one tap. Rivet is built for 1–3-truck HVAC
            and plumbing shops with no office staff; if you have a team that lives in a dashboard and
            want the biggest ecosystem, Jobber is likely the better fit.
          </p>
          <p className="mt-4 text-sm text-fg-muted">
            Comparing something else?{' '}
            <Link href="/vs-housecall-pro" className="text-link underline">
              See Rivet vs Housecall Pro
            </Link>
            .
          </p>
        </div>
      </Section>

      <Section aria-labelledby="tldr-heading" className="bg-surface-muted">
        <h2 id="tldr-heading" className="mx-auto max-w-3xl font-display text-2xl font-bold text-fg">
          The short version
        </h2>
        <div className="mx-auto mt-6 grid max-w-3xl gap-6 sm:grid-cols-2">
          <div className="rounded-lg border border-border bg-surface p-6">
            <h3 className="font-display text-lg font-semibold text-fg">Choose Jobber if…</h3>
            <ul className="mt-3 space-y-2 text-sm text-fg-muted">
              <li>You have office staff who live in a dashboard all day.</li>
              <li>You want native mobile apps for the crew.</li>
              <li>You need tips, financing, or Tap to Pay at the point of payment.</li>
              <li>You value a 10-year ecosystem and deep QuickBooks sync.</li>
            </ul>
          </div>
          <div className="rounded-lg border border-primary bg-surface p-6">
            <h3 className="font-display text-lg font-semibold text-fg">Choose Rivet if…</h3>
            <ul className="mt-3 space-y-2 text-sm text-fg-muted">
              <li>You have no office staff and answer the phone yourself.</li>
              <li>You want calls answered and paperwork done for you, not by you.</li>
              <li>You want the estimate, invoice, and follow-up to happen automatically.</li>
              <li>You want a flat price with the AI included, not a per-conversation add-on.</li>
            </ul>
          </div>
        </div>
      </Section>

      <Section aria-labelledby="compare-heading">
        <div className="mx-auto max-w-4xl">
          <h2 id="compare-heading" className="font-display text-2xl font-bold text-fg">
            Rivet vs. Jobber, feature by feature
          </h2>
          <p className="mt-3 text-sm text-fg-muted">
            Rivet values reflect shipped capability; where Rivet doesn’t yet do something, it says
            “Not yet.” Jobber values are sourced from the pages linked below the table.
          </p>
          <div className="mt-8">
            <CompareTable
              caption="How Rivet and Jobber compare on phone answering, quoting, invoicing, payments, trust, mobile, integrations, and price for a 1–3-truck home-service shop."
              brand="Rivet"
              competitor="Jobber"
              groups={GROUPS}
              sources={SOURCES}
              idPrefix="jobber-src"
            />
          </div>
        </div>
      </Section>

      <Section aria-labelledby="ai-model-heading" className="bg-surface-muted">
        <div className="mx-auto max-w-3xl">
          <h2 id="ai-model-heading" className="font-display text-2xl font-bold text-fg">
            The real difference: capture vs. close the loop
          </h2>
          <p className="mt-4 text-fg-muted">
            Jobber’s AI Receptionist captures the request — it answers the call, offers to book a
            simple visit, and texts back callers who hang up (getjobber.com/features/ai-receptionist,
            accessed July 2026). Drafting quotes and sending invoices lives in a separate in-app
            “Jobber AI Voice and Chat (Beta)” tool that an admin drives by hand
            (help.getjobber.com, accessed July 2026). The receptionist captures; a person still
            carries the work the rest of the way.
          </p>
          <p className="mt-4 text-fg-muted">
            Rivet closes the loop in one conversation: it answers, checks real drive-time
            availability, proposes the booking, drafts the catalog-priced estimate, and raises the
            invoice — then chases payment and reports back in an end-of-day digest. What makes that
            safe without a dispatcher is the trust layer. Every AI action is a typed proposal, not an
            auto-execution. A supervisor agent second-passes bookings and quotes, uncertain prices
            are flagged and never auto-approved, and you approve each action with one tap — often by
            SMS. There’s a full audit trail with undo, and a correction loop where your edits teach
            the system, summarized in the daily digest of what it wasn’t sure about and what it
            learned.
          </p>
        </div>
      </Section>

      <Section aria-labelledby="pricing-heading">
        <div className="mx-auto max-w-3xl">
          <h2 id="pricing-heading" className="font-display text-2xl font-bold text-fg">
            Pricing compared
          </h2>
          <p className="mt-4 text-fg-muted">
            <strong className="text-fg">Rivet</strong> is flat: $299/mo (Solo), $499/mo (Shop), or
            $799/mo (Pro), with the AI answering, estimating, invoicing, and review work included and
            a 14-day free trial (card required, cancel any time before day 15).
          </p>
          <p className="mt-4 text-fg-muted">
            <strong className="text-fg">Jobber</strong> lists plans starting at $29/mo (Core, one
            user, billed annually) and, per secondary pricing breakdowns, ranges up through Connect
            and Grow tiers to a Plus plan reported around $599/mo monthly (getjobber.com/pricing,
            accessed July 2026). Its AI Receptionist is included on the Plus plan but is a
            per-conversation add-on elsewhere — $29/mo for 30 conversations, then $0.79 per
            additional conversation (getjobber.com/features/ai-receptionist, accessed July 2026). So
            a mid-tier Jobber plan plus AI usage is billed separately from the base subscription,
            where Rivet folds it into one flat number. Jobber’s own pricing page and third-party
            breakdowns disagree on individual-vs-team framing and exact digits, so confirm current
            numbers directly before deciding.
          </p>
        </div>
      </Section>

      <Section aria-labelledby="switch-heading" className="bg-surface-muted">
        <div className="mx-auto max-w-3xl">
          <h2 id="switch-heading" className="font-display text-2xl font-bold text-fg">
            Switching from Jobber
          </h2>
          <p className="mt-4 text-fg-muted">
            You don’t have to port your phone number to try Rivet. The realistic path: forward your
            existing business line to your new Rivet number and you’re live the same day, with full
            number porting optional later once you’re confident. Onboarding sets up your brand voice,
            runs a test call, and builds your catalog from your existing price list so estimates are
            grounded in your own numbers from day one. The design target is under 48 hours from
            signup to your first AI-handled call.
          </p>
        </div>
      </Section>

      <Section aria-labelledby="ahead-heading">
        <div className="mx-auto max-w-3xl">
          <h2 id="ahead-heading" className="font-display text-2xl font-bold text-fg">
            Where Jobber is ahead
          </h2>
          <p className="mt-4 text-fg-muted">
            We’d rather you self-select than be sold. Here’s where Jobber genuinely leads today:
          </p>
          <ul className="mt-6 space-y-4">
            {AHEAD.map((item) => (
              <li key={item} className="rounded-lg border border-border bg-surface p-5 text-sm text-fg-muted">
                {item}
              </li>
            ))}
          </ul>
        </div>
      </Section>

      <Section aria-labelledby="faq-heading" className="bg-surface-muted">
        <div className="mx-auto max-w-3xl">
          <h2 id="faq-heading" className="font-display text-2xl font-bold text-fg">
            Rivet vs. Jobber FAQ
          </h2>
          <dl className="mt-8 space-y-8">
            {FAQS.map((faq) => (
              <div key={faq.q}>
                <dt className="font-display text-lg font-semibold text-fg">{faq.q}</dt>
                <dd className="mt-2 text-sm text-fg-muted">{faq.a}</dd>
              </div>
            ))}
          </dl>
        </div>
      </Section>

      <Section aria-labelledby="cta-heading">
        <div className="mx-auto max-w-3xl rounded-lg border border-border bg-surface p-10 text-center">
          <h2 id="cta-heading" className="font-display text-2xl font-bold text-fg">
            See Rivet answer your phone
          </h2>
          <p className="mt-3 text-fg-muted">
            14-day free trial. Card required, cancel any time before day 15.
          </p>
          <div className="mt-8">
            <Link href="/signup" className="btn-primary">
              Start free trial
            </Link>
          </div>
        </div>
      </Section>
    </>
  );
}

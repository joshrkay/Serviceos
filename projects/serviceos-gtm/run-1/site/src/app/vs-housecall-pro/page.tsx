import Link from 'next/link';
import type { Metadata } from 'next';
import { Section } from '@/components/Section';
import { CompareTable, type CompareGroup, type CompareSource } from '@/components/CompareTable';
import { pageMetadata } from '@/lib/metadata';

export const metadata: Metadata = pageMetadata({
  title: 'Housecall Pro Alternative: Rivet vs HCP',
  description:
    'Honest Rivet vs Housecall Pro comparison for small HVAC & plumbing shops: AI answers calls and closes the back-office loop, every action owner-approved.',
  path: '/vs-housecall-pro',
});

const SOURCES: CompareSource[] = [
  { id: 1, label: 'housecallpro.com/pricing', href: 'https://www.housecallpro.com/pricing/' },
  {
    id: 2,
    label: 'help.housecallpro.com — CSR AI Overview',
    href: 'https://help.housecallpro.com/en/articles/9740104-csr-ai-overview',
  },
  {
    id: 3,
    label: 'housecallpro.com/features/ai-team/csr-ai',
    href: 'https://www.housecallpro.com/features/ai-team/csr-ai/',
  },
  {
    id: 4,
    label: 'housecallpro.com — February 2026 product updates',
    href: 'https://www.housecallpro.com/resources/february-2026-product-updates/',
  },
];

const GROUPS: CompareGroup[] = [
  {
    name: 'Phone & booking',
    rows: [
      { feature: 'AI answers calls & chats 24/7 in your shop’s voice', us: true, them: true, themRefs: [2, 3] },
      {
        feature: 'Checks real drive-time availability and proposes the booking',
        us: true,
        them: 'Booking “coming soon”',
        themRefs: [2],
      },
      {
        feature: 'Answer → book → draft quote → invoice in one conversation',
        us: true,
        them: 'Not yet (booking pending)',
        themRefs: [2],
      },
      { feature: 'Dropped-call SMS recovery (~60s)', us: true, them: 'Not documented' },
      {
        feature: 'Emergency / vulnerable-caller detection → patched to owner',
        us: true,
        them: 'Qualifies & tags call reason',
        themRefs: [4],
      },
    ],
  },
  {
    name: 'Estimates & invoices',
    rows: [
      { feature: 'Voice-drafted, catalog-priced estimates (good/better/best)', us: true, them: 'Estimates (manual)', themRefs: [1] },
      { feature: 'E-sign + Stripe deposit on acceptance', us: true, them: true, themRefs: [1] },
      { feature: 'Auto-invoice on completion + dunning + capped late fees', us: true, them: true, themRefs: [1] },
    ],
  },
  {
    name: 'Payments',
    rows: [
      { feature: 'Card payments + payment links', us: true, them: true, themRefs: [1] },
      { feature: 'ACH / bank payments', us: 'Not yet', them: true, themRefs: [1] },
      { feature: 'Tips, Tap to Pay, financing, instant payout', us: 'Not yet', them: true, themRefs: [1] },
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
      { feature: 'Established integrations ecosystem', us: 'Newer', them: true },
    ],
  },
  {
    name: 'Price',
    rows: [
      {
        feature: 'Flat monthly price with AI included',
        us: '$299 / $499 / $799 flat',
        them: '$59–$329/mo + AI Team',
        themRefs: [1],
      },
    ],
  },
];

const AHEAD = [
  'Native iOS and Android apps. Rivet runs in your phone’s browser as a PWA; Housecall Pro ships polished app-store apps your techs may prefer in the field.',
  'Tips, Tap to Pay, consumer financing, and instant payout. Housecall Pro offers these at the point of payment; Rivet takes card payments and payment links only today.',
  'Deep two-way QuickBooks sync. Rivet pushes paid invoices one-way; Housecall Pro’s accounting integration is more mature and bidirectional.',
  'A larger, established ecosystem: a mature marketplace, a longer track record, and years of workflow polish for shops that already have office staff.',
  'Marketing and price-book tooling refined over years, plus a customizable CSR AI voice and call-reason tagging shipped in its February 2026 release.',
];

const FAQS = [
  {
    q: 'Is Rivet a good Housecall Pro alternative for a small plumbing business?',
    a: 'If you want a tool you operate yourself and you have office staff, Housecall Pro is a strong, mature choice. If your real problem is that no one answers the phone or closes out the estimate and invoice without you, Rivet is built for that: an AI that answers 24/7 in your shop’s voice, checks real availability, proposes the booking, and drafts catalog-priced estimates and invoices from the same conversation — every action approved by you in one tap.',
  },
  {
    q: 'Does Housecall Pro have an AI receptionist that books jobs?',
    a: 'Housecall Pro’s CSR AI answers calls and chats around the clock, engages customers, asks clarifying questions, and (as of its February 2026 release) tags call reasons for revenue tracking. But per its Help Center, autonomous job-booking is listed as “coming soon” rather than a currently shipped capability (help.housecallpro.com, accessed July 2026). Confirm current status before relying on it — Housecall Pro ships quickly and this may have changed.',
  },
  {
    q: 'How does Rivet’s pricing compare to Housecall Pro’s?',
    a: 'Rivet is a flat $299 (Solo) / $499 (Shop) / $799 (Pro) per month with the AI included and a 14-day free trial (card required). Housecall Pro’s plans are reported in a $59–$79 (Basic) / $149–$189 (Essentials) / $299–$329 (MAX) per-month band, with additional users and its AI Team features layered on (housecallpro.com/pricing and secondary breakdowns, accessed July 2026 — sources disagree on exact digits, so confirm on the live pricing page).',
  },
  {
    q: 'What does Rivet do that Housecall Pro’s CSR AI doesn’t?',
    a: 'Rivet closes the loop today. Housecall Pro’s CSR AI answers and qualifies, but autonomous booking is “coming soon.” Rivet answers, books against real drive-time availability, drafts the catalog-priced estimate, and raises the invoice from the same call — and wraps every step in a trust layer: typed proposals, a supervisor second-pass, uncertain prices flagged and never auto-approved, one-tap owner approval, and a full audit trail with undo.',
  },
  {
    q: 'Where is Housecall Pro ahead of Rivet?',
    a: 'In several places: native mobile apps, tips, Tap to Pay, consumer financing and instant payout, deep two-way QuickBooks sync, a larger established ecosystem, and mature marketing and price-book tooling. If those matter most to you, Housecall Pro is the safer pick today.',
  },
  {
    q: 'How do I switch from Housecall Pro to Rivet?',
    a: 'You don’t have to port your phone number to start — forward your existing line to your Rivet number and you’re live, with full porting optional later. Onboarding sets up your brand voice, runs a test call, and builds your catalog from your existing price list, with a design target of under 48 hours to your first AI-handled call.',
  },
];

export default function VsHousecallProPage() {
  return (
    <>
      <Section as="div" className="pt-16">
        <div className="mx-auto max-w-3xl">
          <p className="eyebrow">Rivet vs Housecall Pro</p>
          <h1 className="mt-4 font-display text-4xl font-bold text-fg">
            Rivet vs. Housecall Pro: which one runs your back office?
          </h1>
          <p className="mt-6 text-lg text-fg-muted">
            Housecall Pro is software you operate: a mature platform your office staff uses to run
            scheduling, quoting, invoicing, and marketing. Rivet is an AI that operates the office
            for you — it answers the phone 24/7 in your shop’s voice, books the job, and drafts the
            estimate and invoice, with every action approved by you in one tap. Rivet is built for
            1–3-truck HVAC and plumbing shops with no office staff; if you have a team that lives in a
            dashboard and want the biggest ecosystem, Housecall Pro is likely the better fit.
          </p>
        </div>
      </Section>

      <Section aria-labelledby="tldr-heading" className="bg-surface-muted">
        <h2 id="tldr-heading" className="mx-auto max-w-3xl font-display text-2xl font-bold text-fg">
          The short version
        </h2>
        <div className="mx-auto mt-6 grid max-w-3xl gap-6 sm:grid-cols-2">
          <div className="rounded-lg border border-border bg-surface p-6">
            <h3 className="font-display text-lg font-semibold text-fg">Choose Housecall Pro if…</h3>
            <ul className="mt-3 space-y-2 text-sm text-fg-muted">
              <li>You have office staff who live in a dashboard all day.</li>
              <li>You want native mobile apps for the crew.</li>
              <li>You need tips, financing, or Tap to Pay at the point of payment.</li>
              <li>You value mature marketing tools and deep QuickBooks sync.</li>
            </ul>
          </div>
          <div className="rounded-lg border border-primary bg-surface p-6">
            <h3 className="font-display text-lg font-semibold text-fg">Choose Rivet if…</h3>
            <ul className="mt-3 space-y-2 text-sm text-fg-muted">
              <li>You have no office staff and answer the phone yourself.</li>
              <li>You want calls answered and paperwork done for you, not by you.</li>
              <li>You want the booking, estimate, and invoice to happen — and close — automatically.</li>
              <li>You want a flat price with the AI included.</li>
            </ul>
          </div>
        </div>
      </Section>

      <Section aria-labelledby="compare-heading">
        <div className="mx-auto max-w-4xl">
          <h2 id="compare-heading" className="font-display text-2xl font-bold text-fg">
            Rivet vs. Housecall Pro, feature by feature
          </h2>
          <p className="mt-3 text-sm text-fg-muted">
            Rivet values reflect shipped capability; where Rivet doesn’t yet do something, it says
            “Not yet.” Housecall Pro values are sourced from the pages linked below the table.
          </p>
          <div className="mt-8">
            <CompareTable
              caption="How Rivet and Housecall Pro compare on phone answering, quoting, invoicing, payments, trust, mobile, integrations, and price for a 1–3-truck home-service shop."
              brand="Rivet"
              competitor="Housecall Pro"
              groups={GROUPS}
              sources={SOURCES}
              idPrefix="hcp-src"
            />
          </div>
        </div>
      </Section>

      <Section aria-labelledby="ai-model-heading" className="bg-surface-muted">
        <div className="mx-auto max-w-3xl">
          <h2 id="ai-model-heading" className="font-display text-2xl font-bold text-fg">
            The real difference: qualify vs. close the loop
          </h2>
          <p className="mt-4 text-fg-muted">
            Housecall Pro’s CSR AI answers calls and chats 24/7, engages callers with clarifying
            questions, and tags the reason for each call for revenue tracking (its February 2026
            release added New Job Inquiry, Emergency Repair, Follow-Up, and Sales Call tags). But per
            its own Help Center, autonomous job-booking is listed as “coming soon”
            (help.housecallpro.com, accessed July 2026) — the AI answers and qualifies, and a person
            still books and carries the work forward.
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
            <strong className="text-fg">Housecall Pro</strong> is reported in a band of roughly
            $59–$79/mo (Basic, one user), $149–$189/mo (Essentials, up to five users), and
            $299–$329/mo (MAX), with additional users around $35/mo each and its AI Team / CSR AI
            features layered on (housecallpro.com/pricing and secondary breakdowns, accessed July
            2026). Its free trial runs 14 days with full MAX-plan access and no credit card required
            to start. Exact digits vary across sources, so confirm current numbers on the live
            pricing page before deciding.
          </p>
        </div>
      </Section>

      <Section aria-labelledby="switch-heading" className="bg-surface-muted">
        <div className="mx-auto max-w-3xl">
          <h2 id="switch-heading" className="font-display text-2xl font-bold text-fg">
            Switching from Housecall Pro
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
            Where Housecall Pro is ahead
          </h2>
          <p className="mt-4 text-fg-muted">
            We’d rather you self-select than be sold. Here’s where Housecall Pro genuinely leads
            today:
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
            Rivet vs. Housecall Pro FAQ
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

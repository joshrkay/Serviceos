import type { Metadata } from 'next';
import Link from 'next/link';
import { Section } from '@/components/Section';
import { JsonLd } from '@/components/JsonLd';
import { pageMetadata } from '@/lib/metadata';
import { faqPageJsonLd, breadcrumbJsonLd } from '@/lib/schema';

export const metadata: Metadata = pageMetadata({
  title: 'FAQ: AI answering & back office questions',
  description:
    'Answers on how Rivet answers calls, drafts estimates, handles emergencies, prices, and what it cannot do yet — in plain language.',
  path: '/faq',
});

interface FaqItem {
  q: string;
  a: string;
  linkHref?: string;
  linkLabel?: string;
}

interface FaqGroup {
  heading: string;
  items: FaqItem[];
}

/**
 * Answers are drawn from research/aeo-question-set.md, lightly reworded for
 * this page. Every capability claim traces to a ✅ row in claims.md. Semantic
 * structure on purpose: h2 group, h3 question, p answer — the schema worker
 * lifts this into structured data alongside the JSON-LD below.
 */
const FAQ_GROUPS: FaqGroup[] = [
  {
    heading: 'What Rivet is',
    items: [
      {
        q: 'What does Rivet ServiceOS actually do?',
        a: "Rivet is a voice-AI back office for 1-3 truck HVAC and plumbing shops. It answers your phone 24/7 in your shop's own voice, checks real availability, and proposes the booking. From the same conversation it drafts a catalog-priced estimate or invoice. You approve every action with one tap — nothing books, quotes, or sends itself.",
      },
      {
        q: 'Does Rivet work for both HVAC and plumbing businesses?',
        a: "Yes. Rivet's current version is built specifically for HVAC and plumbing owner-operators running 1-3 trucks with no office staff — that's the whole design target, not an afterthought.",
      },
      {
        q: 'Does Rivet replace a dispatcher or office manager?',
        a: "It's built for shops that have no office staff at all. The AI answers the phone, books the job, drafts the estimate and invoice from your own price book, chases payment, and sends an end-of-day digest — every action is a human-approved proposal, so you stay in control without hiring anyone to run the loop.",
      },
    ],
  },
  {
    heading: 'How the AI works',
    items: [
      {
        q: 'Can AI actually answer phones for a contractor, or is it just a gimmick?',
        a: "It's shipped, not a demo. Rivet's AI answers the phone 24/7 in your shop's own voice, classifies the caller's intent, checks real availability (including drive time and schedule conflicts), and proposes a booking you approve with one tap by SMS. If a call drops, the caller gets an automatic SMS follow-up within about 60 seconds so the lead isn't lost to a dead line.",
      },
      {
        q: 'Can the AI draft an estimate just from a phone call?',
        a: 'Yes. Estimates are voice-drafted from the call and priced against your own price book through a catalog resolver — anything not in the catalog is flagged for your review instead of guessed at. Estimates can be presented good/better/best, and once accepted, the customer can e-sign and pay a Stripe deposit in the same flow.',
      },
      {
        q: 'Does the AI ever guess at a price if it is not in your price book?',
        a: "No — that's a hard rule. Every AI-drafted line-item price is grounded in your own catalog. An uncatalogued line item gets flagged and its confidence is capped below the auto-approve threshold, so it always needs a human look before it goes out.",
      },
      {
        q: 'Does Rivet handle Google reviews?',
        a: 'Yes. After a job, Rivet sends review requests with 4-star gating toward Google, monitors the Google reviews that come in, and drafts a response — a public reply, plus a private apology where one is warranted. Nothing posts publicly until you approve it.',
      },
    ],
  },
  {
    heading: 'Trust & approvals',
    items: [
      {
        q: 'What happens if someone calls with a real emergency?',
        a: 'The AI is built to detect emergency and vulnerability signals — medical situations, elderly callers, severe weather damage. When it does, it stops the normal booking flow and patches the call straight through to your phone instead of handling it automatically.',
      },
      {
        q: 'Can Rivet’s AI negotiate a discount with a customer?',
        a: 'No. The AI never discounts and never commits to a scope change — that’s a hard guardrail, not a setting you can turn on. If a caller pushes on price, it routes the decision to you rather than giving anything away on its own.',
      },
      {
        q: 'What does "human-approved proposal" actually mean in practice?',
        a: 'The AI never executes a booking, quote, invoice, discount, or review reply on its own. Every one of those is generated as a typed, specific proposal — you see exactly what it wants to do and approve it with one tap, often by SMS, before it happens. Every action that does go through is logged to an audit trail.',
      },
      {
        q: 'What happens if the AI makes a mistake or misunderstands a caller?',
        a: "Every AI action requires your approval before anything executes — nothing auto-runs. There's a full audit trail with undo, a supervisor pass that reviews bookings and quotes a second time, confidence markers on anything uncertain, and a correction loop where your edits teach the system — surfaced in a daily digest of what it got wrong and what it learned.",
      },
    ],
  },
  {
    heading: 'Pricing & trial',
    items: [
      {
        q: 'How much does Rivet cost?',
        a: 'Solo is $299/month, Shop is $499/month, and Pro is $799/month, flat — every plan includes the AI phone agent plus the full estimate, invoice, and follow-up back office.',
        linkHref: '/pricing',
        linkLabel: 'See the full pricing breakdown',
      },
      {
        q: 'How long is the free trial, and what happens after?',
        a: "14 days free, card required at signup, cancel any time before day 15. After the trial, you're billed the plan price monthly until you cancel — no contract.",
      },
      {
        q: 'Does Rivet take payments — does it support ACH?',
        a: 'Rivet takes card payments via Stripe payment links, on invoices, estimate deposits, and recurring membership billing. ACH is not currently supported — card payments and payment links are the shipped path today.',
      },
    ],
  },
  {
    heading: 'Getting started',
    items: [
      {
        q: 'What happens after I sign up?',
        a: "You set up your business basics, load your price book, set the AI's brand voice, get your phone number provisioned, and run a test call — in that order. The design target is under 48 hours from signup to your first AI-handled call.",
      },
      {
        q: 'Is there a Rivet mobile app?',
        a: 'Rivet is a progressive web app — it works on your phone through the browser, no app-store install needed. It is not a native iOS or Android app today.',
      },
      {
        q: "What can't Rivet do yet?",
        a: "We'd rather tell you than have you find out. Not shipped yet: turning a photo of the job into an estimate (photo intake exists, the AI analysis doesn't), ACH bank payments, property-manager account routing, tip capture and tap-to-pay, consumer financing, equipment and truck inventory tracking, per-job profit by voice, offline voice capture, and a native iOS/Android app. It's roadmap, not vapor — and we'd rather say \"not yet\" than pretend.",
      },
    ],
  },
  {
    heading: 'Comparisons',
    items: [
      {
        q: 'What is the best Jobber alternative for a small HVAC or plumbing shop?',
        a: "Depends what's actually broken. If it's paperwork, Jobber-style tools work fine. If the real problem is that nobody answers the phone or closes the estimate-invoice-follow-up loop without you, look at Rivet: the AI answers, checks real availability, proposes the booking, and drafts the estimate or invoice from the same call.",
        linkHref: '/vs-jobber',
        linkLabel: 'See the full Rivet vs Jobber comparison',
      },
      {
        q: "What's the difference between an AI answering service and Rivet ServiceOS?",
        a: 'Most standalone AI answering services stop at answering the call and handing you a lead or a booking notification. Rivet continues the workflow: it checks availability, proposes the booking, drafts the catalog-priced estimate or invoice, chases the payment, and reports back in an end-of-day digest. The call is the start of the back-office workflow, not a separate add-on.',
      },
      {
        q: 'Why not just use a live answering service instead of an AI receptionist?',
        a: "A live answering service relays a message back to you — it doesn't have access to your real schedule, price book, or invoicing, so a human still has to close the loop afterward. Rivet checks actual drive-time-adjusted availability and proposes a real booking, then can carry the same conversation into a catalog-priced estimate — a message-taking service structurally can't do that.",
      },
    ],
  },
];

export default function FaqPage() {
  const faqItems = FAQ_GROUPS.flatMap((group) => group.items.map((item) => ({ q: item.q, a: item.a })));

  return (
    <>
      <JsonLd data={faqPageJsonLd(faqItems)} />
      <JsonLd
        data={breadcrumbJsonLd([
          { name: 'Home', path: '/' },
          { name: 'FAQ', path: '/faq' },
        ])}
      />
      <Section as="div" className="pt-16">
        <div className="mx-auto max-w-3xl text-center">
          <p className="eyebrow">FAQ</p>
          <h1 className="mt-4 font-display text-4xl font-bold text-fg">Frequently asked questions</h1>
          <p className="mt-6 text-lg text-fg-muted">
            Straight answers on how Rivet&apos;s AI answers your phone, what it can and can&apos;t
            do, and what it costs. If you don&apos;t see your question, ask us at signup.
          </p>
        </div>
      </Section>

      <Section aria-labelledby="faq-heading">
        <h2 id="faq-heading" className="sr-only">
          All questions
        </h2>
        <div className="mx-auto max-w-2xl space-y-14">
          {FAQ_GROUPS.map((group) => (
            <section key={group.heading} aria-labelledby={`group-${group.heading}`}>
              <h2 id={`group-${group.heading}`} className="font-display text-2xl font-bold text-fg">
                {group.heading}
              </h2>
              <div className="mt-6 space-y-8">
                {group.items.map((item) => (
                  <div key={item.q}>
                    <h3 className="font-semibold text-fg">{item.q}</h3>
                    <p className="mt-2 text-sm text-fg-muted">
                      {item.a}
                      {item.linkHref && item.linkLabel && (
                        <>
                          {' '}
                          <Link href={item.linkHref} className="text-link underline">
                            {item.linkLabel}
                          </Link>
                          .
                        </>
                      )}
                    </p>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </Section>
    </>
  );
}

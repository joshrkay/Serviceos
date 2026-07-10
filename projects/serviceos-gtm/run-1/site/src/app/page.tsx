import Link from 'next/link';
import type { Metadata } from 'next';
import { Section } from '@/components/Section';
import { PricingCards } from '@/components/PricingCards';
import { pageMetadata } from '@/lib/metadata';

export const metadata: Metadata = pageMetadata({
  title: 'AI Answering Service for HVAC & Plumbing',
  description:
    'AI answers your phone 24/7, books the job, drafts the estimate, and chases the invoice — you approve every action from your truck. Free 14-day trial.',
  path: '/',
});

const HOW_IT_WORKS = [
  {
    step: '1',
    title: 'It answers and books',
    body: 'Every call, 24/7, in your shop’s voice. It checks your real availability — drive time and conflicts — and proposes the booking.',
  },
  {
    step: '2',
    title: 'You approve by one tap',
    body: 'The booking, the estimate, the invoice — each lands as a proposal on your phone. One tap sends it. Nothing goes out on its own.',
  },
  {
    step: '3',
    title: 'Invoices and follow-ups happen',
    body: 'Invoices draft when the job is done, payment links go out, and unpaid ones get chased on a schedule — without you remembering to.',
  },
];

const TRUST = [
  {
    title: 'Nothing sends without you',
    body: 'Every AI action is a typed proposal that needs your approval before it runs. Full audit trail, with undo.',
  },
  {
    title: 'A supervisor checks the work',
    body: 'A second-pass agent reviews the bookings and quotes the main system made, and flags anything that looks off.',
  },
  {
    title: 'It shows its uncertainty',
    body: 'Prices are grounded in your own price book. Anything it can’t confirm gets a low-confidence flag instead of a guess.',
  },
  {
    title: 'It never negotiates',
    body: 'The AI never discounts and never commits to a scope change. Pricing pushback comes straight to you.',
  },
];

const FAQ_TEASER = [
  {
    q: 'Can AI really answer the phone for my shop, or is it a gimmick?',
    a: 'It’s shipped, not a demo. The AI answers 24/7 in your shop’s voice, classifies the call, checks real availability, and proposes the booking — you approve it by text.',
  },
  {
    q: 'What happens when the AI gets something wrong?',
    a: 'Nothing sends without your approval. Every action is a proposal with an audit trail and undo, a supervisor agent double-checks bookings and quotes, and the nightly digest tells you what it wasn’t sure about.',
  },
  {
    q: 'Does it replace a dispatcher or office manager?',
    a: 'It’s built for shops with no office staff. It answers, books, estimates, invoices, and chases payment — you stay in control by approving each step.',
  },
];

/** Illustrative SMS/chat mock — CSS only. NOT a real customer’s messages. */
function MoneyMomentMock() {
  return (
    <div className="mx-auto w-full max-w-sm">
      <p className="mb-3 text-center text-xs font-semibold uppercase tracking-[0.08em] text-fg-subtle">
        What this looks like
      </p>
      <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-md">
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <span className="text-sm font-semibold text-fg">Rivet</span>
          <span className="data text-xs text-fg-subtle">5:45 AM</span>
        </div>
        <div className="space-y-3 p-4">
          <p className="text-center text-xs text-fg-subtle">
            You slept through 7 calls overnight.
          </p>

          {/* Incoming digest from Rivet */}
          <div className="max-w-[85%] rounded-lg rounded-tl-sm bg-surface-sunk px-3.5 py-2.5 text-sm text-fg">
            Good morning. 7 calls overnight. 4 booked (Tue &amp; Wed). 2 weren&rsquo;t a fit &mdash;
            out of area, I declined politely. 1 needs your call: Mrs. Alvarez, no AC, 2 small kids,
            you serviced her in May. Want me to dial her?
          </div>

          {/* One-tap approve (illustrated control) */}
          <div className="flex justify-end">
            <span
              aria-hidden
              className="inline-flex min-h-11 items-center gap-2 rounded-md bg-accent-strong px-4 text-sm font-semibold text-white"
            >
              &#10003; Yes, dial her
            </span>
          </div>

          {/* Confirmation */}
          <div className="max-w-[85%] rounded-lg rounded-tl-sm bg-surface-sunk px-3.5 py-2.5 text-sm text-fg">
            Calling Mrs. Alvarez now. I&rsquo;ll text you when it&rsquo;s booked.
          </div>
        </div>
      </div>
      <p className="mt-3 text-center text-xs text-fg-subtle">
        Illustration of how Rivet works &mdash; not a real customer&rsquo;s messages.
      </p>
    </div>
  );
}

export default function HomePage() {
  return (
    <>
      {/* HERO */}
      <Section as="div" className="pt-14 sm:pt-20">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div className="max-w-xl">
            <p className="eyebrow">AI back office for HVAC &amp; plumbing</p>
            <h1 className="mt-4 font-display text-4xl font-black leading-[1.05] tracking-[-0.02em] text-fg sm:text-5xl">
              You handle the work.
              <br />
              We handle the business.
            </h1>
            <p className="mt-6 text-lg leading-relaxed text-fg-muted">
              AI answers your phone, books the job, sends the estimate, and chases the invoice.
              You approve everything from your truck.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link href="/signup" className="btn-primary w-full sm:w-auto">
                Start free 14-day trial
              </Link>
              <a href="#demo" className="btn-secondary w-full sm:w-auto">
                Watch the demo
              </a>
            </div>
            <p className="mt-3 text-xs text-fg-subtle">
              14-day free trial &middot; card required &middot; cancel anytime before day 15
            </p>
          </div>

          {/* Money-moment vignette */}
          <MoneyMomentMock />
        </div>
      </Section>

      {/* VIDEO */}
      <Section as="div" id="demo" className="pt-0">
        <figure className="mx-auto max-w-4xl">
          <video
            className="aspect-video w-full rounded-xl border border-border bg-surface-sunk"
            controls
            preload="none"
            poster="/media/demo-poster.jpg"
          >
            <source src="/media/demo-hero.mp4" type="video/mp4" />
            Your browser can&rsquo;t play this video. It shows how Rivet answers a call, books the
            job, and sends the estimate.
          </video>
          <figcaption className="mt-3 text-center text-sm text-fg-subtle">Product demo</figcaption>
        </figure>
      </Section>

      {/* HOW-IT-WORKS STRIP */}
      <Section aria-labelledby="how-heading" className="bg-surface">
        <h2
          id="how-heading"
          className="text-center font-display text-3xl font-bold tracking-[-0.01em] text-fg"
        >
          How it works
        </h2>
        <p className="mx-auto mt-3 max-w-2xl text-center text-fg-muted">
          The whole loop runs from a phone call to a paid invoice. You touch it three times.
        </p>
        <div className="mt-10 grid gap-6 md:grid-cols-3">
          {HOW_IT_WORKS.map((item) => (
            <div key={item.step} className="rounded-lg border border-border bg-bg p-6">
              <span className="data inline-flex h-9 w-9 items-center justify-center rounded-md bg-primary text-base font-bold text-primary-fg">
                {item.step}
              </span>
              <h3 className="mt-4 font-display text-xl font-bold text-fg">{item.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-fg-muted">{item.body}</p>
            </div>
          ))}
        </div>
        <div className="mt-8 text-center">
          <Link href="/how-it-works" className="btn-secondary">
            See the full walkthrough
          </Link>
        </div>
      </Section>

      {/* PROOF / TRUST — differentiation via architecture honesty (no testimonials pre-launch) */}
      <Section aria-labelledby="proof-heading">
        <div className="mx-auto max-w-2xl text-center">
          <p className="eyebrow">Why trust it</p>
          <h2
            id="proof-heading"
            className="mt-4 font-display text-3xl font-bold tracking-[-0.01em] text-fg sm:text-4xl"
          >
            The only AI back office that tells you what it got wrong.
          </h2>
          <p className="mt-4 text-fg-muted">
            No AI is right every time. The trust isn&rsquo;t perfection &mdash; it&rsquo;s how the
            system behaves when it&rsquo;s unsure. Every part of Rivet is built to surface a mistake
            before it reaches your customer.
          </p>
        </div>
        <div className="mx-auto mt-10 grid max-w-4xl gap-6 sm:grid-cols-2">
          {TRUST.map((item) => (
            <div key={item.title} className="rounded-lg border border-border bg-surface p-6">
              <h3 className="font-display text-xl font-bold text-fg">{item.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-fg-muted">{item.body}</p>
            </div>
          ))}
        </div>
        <div className="mx-auto mt-6 max-w-4xl rounded-lg border border-border bg-surface p-6">
          <h3 className="font-display text-xl font-bold text-fg">
            And a nightly digest of what it wasn&rsquo;t sure about
          </h3>
          <p className="mt-2 text-sm leading-relaxed text-fg-muted">
            Every evening you get a text with the day&rsquo;s schedule, revenue, and follow-ups
            &mdash; plus a plain list of what it flagged, what you corrected, and what it learned.
          </p>
        </div>
      </Section>

      {/* JOBBER WEDGE TEASER */}
      <Section aria-labelledby="jobber-heading" className="bg-surface">
        <div className="mx-auto max-w-2xl text-center">
          <h2
            id="jobber-heading"
            className="font-display text-3xl font-bold tracking-[-0.01em] text-fg"
          >
            Jobber gives you better paperwork. Rivet does the paperwork.
          </h2>
          <p className="mt-4 text-fg-muted">
            Field-service tools hand you a tidier app to run yourself. Rivet answers the phone, books
            the job, and sends the estimate and invoice &mdash; so the work happens whether or not
            you ever open a screen.
          </p>
          <div className="mt-8">
            <Link href="/vs-jobber" className="btn-secondary">
              See Rivet vs Jobber
            </Link>
          </div>
        </div>
      </Section>

      {/* PRICING TEASER */}
      <Section aria-labelledby="pricing-teaser-heading">
        <h2
          id="pricing-teaser-heading"
          className="text-center font-display text-3xl font-bold tracking-[-0.01em] text-fg"
        >
          Simple, flat pricing
        </h2>
        <p className="mx-auto mt-3 max-w-2xl text-center text-fg-muted">
          One monthly price covers the whole back office &mdash; not just the phone line. Every plan
          includes a 14-day free trial.
        </p>
        <div className="mt-10">
          <PricingCards compact />
        </div>
        <div className="mt-8 text-center">
          <Link href="/pricing" className="btn-secondary">
            Compare plans
          </Link>
        </div>
      </Section>

      {/* FAQ TEASER */}
      <Section aria-labelledby="faq-teaser-heading" className="bg-surface">
        <h2
          id="faq-teaser-heading"
          className="text-center font-display text-3xl font-bold tracking-[-0.01em] text-fg"
        >
          Questions, answered
        </h2>
        <dl className="mx-auto mt-10 max-w-2xl divide-y divide-border">
          {FAQ_TEASER.map((item) => (
            <div key={item.q} className="py-5">
              <dt className="font-display text-lg font-bold text-fg">{item.q}</dt>
              <dd className="mt-2 text-sm leading-relaxed text-fg-muted">{item.a}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-8 text-center">
          <Link href="/faq" className="btn-secondary">
            All FAQs
          </Link>
        </div>
      </Section>

      {/* FINAL CTA BAND */}
      <Section as="div">
        <div className="theme-dark rounded-xl bg-bg px-6 py-14 text-center">
          <h2 className="mx-auto max-w-2xl font-display text-3xl font-bold tracking-[-0.01em] text-fg sm:text-4xl">
            Stop running the business from your phone at 11 PM.
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-fg-muted">
            Let the AI answer, book, quote, and chase &mdash; and approve what matters in 30 seconds
            a day. Start free, cancel anytime before day 15.
          </p>
          <div className="mt-8">
            <Link href="/signup" className="btn-primary">
              Start free 14-day trial
            </Link>
          </div>
        </div>
      </Section>
    </>
  );
}

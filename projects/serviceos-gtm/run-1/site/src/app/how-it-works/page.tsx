import Link from 'next/link';
import type { Metadata } from 'next';
import { Section } from '@/components/Section';
import { JsonLd } from '@/components/JsonLd';
import { pageMetadata } from '@/lib/metadata';
import { breadcrumbJsonLd } from '@/lib/schema';

export const metadata: Metadata = pageMetadata({
  title: 'How it works: AI answers, books & invoices',
  description:
    'The whole loop — the AI answers the call, books the job, drafts the estimate and invoice, and sends a nightly digest. You approve every step.',
  path: '/how-it-works',
});

/** Illustrative sample messages — Rivet’s phrasing, not real customer chats. */
const STAGES = [
  {
    n: '1',
    title: 'The call comes in',
    body: 'A customer calls while you’re under a condenser, driving, or asleep. Rivet picks up on the first ring, 24/7. If a call ever drops, the caller gets a text back within about a minute so the lead isn’t lost to a dead line.',
    sample:
      'Hi, this is M&R Mechanical’s office — looks like we got cut off. What can we help with? Text or call back, we’re here.',
  },
  {
    n: '2',
    title: 'The AI answers in your shop’s voice',
    body: 'It sounds like your shop, not a call center. It figures out what the caller needs, checks your real availability — drive time and schedule conflicts included — and proposes a time. Emergencies and vulnerable callers (medical, elderly, severe weather) skip the booking flow and get patched straight to your phone.',
    sample:
      'David Chen wants a new install consult. I offered Thu 2pm or Fri 10am. He picked Thu — I’ll confirm once you approve.',
  },
  {
    n: '3',
    title: 'The proposal lands on your phone',
    body: 'Nothing is booked, quoted, or sent yet. It arrives as a proposal you can read in five seconds — with the source it used and a confidence flag on anything it couldn’t fully confirm.',
    sample:
      'Estimate drafted from your call with Mr. Khan + Carlos’s notes: $1,420. One line I’m not sure about — the expansion valve model — flagged for you.',
  },
  {
    n: '4',
    title: 'One tap',
    body: 'Approve and it goes. Or tap a line to change it — “make that a 3-ton condenser” — and it redrafts. Reply NO to undo. The AI never executes an action on its own; the tap is always yours.',
    sample: 'Approve & send  ·  Edit a line  ·  Reply NO to undo',
  },
  {
    n: '5',
    title: 'The estimate, invoice, and payment link',
    body: 'Estimates are priced from your own price book, offered as good / better / best, and can be e-signed with a Stripe deposit on acceptance. When the job’s done, the invoice auto-drafts, a card payment link goes out, and unpaid invoices get a friendly follow-up cadence — no ACH, just cards and payment links.',
    sample:
      'Invoice #1043 sent to the Martins with a payment link — $650. I’ll follow up Friday if it’s still unpaid.',
  },
  {
    n: '6',
    title: 'The nightly digest',
    body: 'Every evening, one text: the day’s jobs, revenue, and pipeline — plus a plain list of what it wasn’t sure about, what you corrected, and what it learned. That’s your dashboard. No app to open.',
    sample:
      'Today: 4 jobs done ($3,840 invoiced, $2,100 paid). 5 quotes out. 3 follow-ups sent — 1 paid. Tomorrow: 6 jobs, all confirmed. Nothing else needs you.',
  },
];

const NEVER = [
  {
    title: 'Never negotiates',
    body: 'The AI doesn’t discount and doesn’t commit to a scope change. Pricing pushback routes to you with a recommendation — you decide.',
  },
  {
    title: 'Never sends without your approval',
    body: 'Every booking, quote, and message is a proposal. It waits for your tap. There’s an audit trail of every action, with undo.',
  },
  {
    title: 'Never hides a mistake',
    body: 'When it’s unsure, it says so — a low-confidence flag, a question, or a line in the nightly “what I wasn’t sure about.” It never guesses a price that isn’t in your book.',
  },
];

const ONBOARDING = [
  {
    n: '1',
    title: 'Sign up',
    body: 'Start the 14-day free trial. Card required, cancel anytime before day 15.',
  },
  {
    n: '2',
    title: 'We set up your number and voice',
    body: 'We provision a phone number (or forward yours) and tune the AI to sound like your shop.',
  },
  {
    n: '3',
    title: 'Make a test call',
    body: 'Call in yourself, hear how it answers, and adjust anything before real customers reach it.',
  },
  {
    n: '4',
    title: 'Go live',
    body: 'Your first AI-handled call. We design onboarding to get here in under 48 hours — that’s the target we build toward, not a guarantee.',
  },
];

export default function HowItWorksPage() {
  return (
    <>
      <JsonLd
        data={breadcrumbJsonLd([
          { name: 'Home', path: '/' },
          { name: 'How it works', path: '/how-it-works' },
        ])}
      />
      <Section as="div" className="pt-14">
        <div className="mx-auto max-w-3xl text-center">
          <p className="eyebrow">How it works</p>
          <h1 className="mt-4 font-display text-4xl font-black leading-[1.05] tracking-[-0.02em] text-fg sm:text-5xl">
            From a phone call to a paid invoice
          </h1>
          <p className="mt-6 text-lg leading-relaxed text-fg-muted">
            Rivet runs the whole loop. You step in three times: to approve a booking, a quote, or a
            message. Here’s each stage — with the kind of thing it actually says.
          </p>
          <p className="mt-4 text-xs text-fg-subtle">
            Sample messages below are illustrations of Rivet’s phrasing, not real customer
            conversations.
          </p>
        </div>
      </Section>

      <Section aria-labelledby="stages-heading" className="bg-surface">
        <h2 id="stages-heading" className="sr-only">
          The loop, stage by stage
        </h2>
        <ol className="mx-auto max-w-3xl space-y-6">
          {STAGES.map((stage) => (
            <li key={stage.n} className="rounded-lg border border-border bg-bg p-6">
              <div className="flex gap-4">
                <span className="data inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary text-base font-bold text-primary-fg">
                  {stage.n}
                </span>
                <div className="min-w-0">
                  <h3 className="font-display text-xl font-bold text-fg">{stage.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-fg-muted">{stage.body}</p>
                  <p className="mt-4 rounded-md border-l-2 border-accent-strong bg-surface-sunk px-4 py-3 text-sm italic text-fg">
                    “{stage.sample}”
                  </p>
                </div>
              </div>
            </li>
          ))}
        </ol>
      </Section>

      {/* WHAT IT NEVER DOES */}
      <Section aria-labelledby="never-heading">
        <div className="mx-auto max-w-2xl text-center">
          <p className="eyebrow">The guardrails</p>
          <h2
            id="never-heading"
            className="mt-4 font-display text-3xl font-bold tracking-[-0.01em] text-fg sm:text-4xl"
          >
            What it never does
          </h2>
        </div>
        <div className="mx-auto mt-10 grid max-w-4xl gap-6 md:grid-cols-3">
          {NEVER.map((item) => (
            <div key={item.title} className="rounded-lg border border-border bg-surface p-6">
              <h3 className="font-display text-lg font-bold text-fg">{item.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-fg-muted">{item.body}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* ONBOARDING */}
      <Section aria-labelledby="onboarding-heading" className="bg-surface">
        <div className="mx-auto max-w-2xl text-center">
          <p className="eyebrow">Getting started</p>
          <h2
            id="onboarding-heading"
            className="mt-4 font-display text-3xl font-bold tracking-[-0.01em] text-fg sm:text-4xl"
          >
            From signup to a live number
          </h2>
        </div>
        <ol className="mx-auto mt-10 grid max-w-4xl gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {ONBOARDING.map((step) => (
            <li key={step.n} className="rounded-lg border border-border bg-bg p-6">
              <span className="data inline-flex h-9 w-9 items-center justify-center rounded-md bg-primary text-base font-bold text-primary-fg">
                {step.n}
              </span>
              <h3 className="mt-4 font-display text-lg font-bold text-fg">{step.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-fg-muted">{step.body}</p>
            </li>
          ))}
        </ol>
        <div className="mt-10 text-center">
          <Link href="/signup" className="btn-primary">
            Start free 14-day trial
          </Link>
        </div>
      </Section>
    </>
  );
}

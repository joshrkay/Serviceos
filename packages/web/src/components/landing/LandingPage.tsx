import { useEffect } from 'react';
import { Link } from 'react-router';
import {
  Phone,
  FileText,
  CreditCard,
  Moon,
  Check,
  ArrowRight,
  AlertCircle,
  Smartphone,
  DollarSign,
  Clock,
  ShieldCheck,
} from 'lucide-react';
import { Button } from '../ui/button';
import { track, trackFunnel } from '../../lib/analytics';
import { MarketingHeader } from '../marketing/MarketingHeader';
import { MarketingFooter } from '../marketing/MarketingFooter';
import { StoreBadges } from '../marketing/StoreBadges';
import { SocialProof } from '../marketing/SocialProof';

const onCtaClick = (location: string) => () =>
  track('landing_signup_clicked', { location });
const onPricingCtaClick = () => track('pricing_cta_clicked', { location: 'pricing_card' });

export function LandingPage() {
  // Top of the funnel. Fires once on mount. Pre-auth, so tenant_id/user_id
  // are null until identify() binds them after signup.
  useEffect(() => {
    trackFunnel('view_landing');
  }, []);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <MarketingHeader />
      <Hero />
      <TrustBar />
      <ProblemSection />
      <HowItWorksSection />
      <FeaturesSection />
      <ComparisonSection />
      <TrustSection />
      <SocialProof />
      <MobileAppSection />
      <PricingSection />
      <FAQSection />
      <FinalCTASection />
      <MarketingFooter />
      <StickyMobileCTA />
    </div>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden bg-slate-900">
      <div className="mx-auto max-w-6xl px-6 py-20 md:py-28">
        <div className="mx-auto max-w-3xl text-center">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-800 px-3 py-1 text-xs text-slate-300">
            <span className="size-1.5 rounded-full bg-green-500" />
            Built for solo HVAC, plumbing &amp; service-trade owners
          </div>
          <h1 className="text-4xl font-medium tracking-tight text-white sm:text-5xl md:text-6xl">
            Your AI dispatcher.
          </h1>
          <p className="mt-6 text-lg leading-relaxed text-slate-300 sm:text-xl">
            Rivet answers your phone, books your jobs, sends your
            estimates, and chases your invoices. You approve what matters
            in 30 seconds a day.
          </p>
          <p className="mt-3 text-base text-slate-400">
            Built for the shop with 1&ndash;3 trucks and no office.
          </p>
          <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link to="/signup" onClick={onCtaClick('hero')}>
              <Button variant="brand" size="lg" rightIcon={<ArrowRight size={16} />}>
                Start 14-day free trial
              </Button>
            </Link>
            <a href="#how">
              <Button
                variant="outline"
                size="lg"
                className="border-slate-600 bg-transparent text-slate-200 hover:border-slate-500 hover:bg-slate-800 hover:text-white"
              >
                See how it works
              </Button>
            </a>
          </div>
          <p className="mt-4 text-xs text-slate-400">
            Card on file, nothing charged for 14 days &middot; Cancel anytime
          </p>
        </div>
      </div>
    </section>
  );
}

/**
 * Honest value/trust bar directly under the dark hero (navy + orange — the
 * pairing that reads as premium and makes the CTA the obvious action). Every
 * item is a defensible claim, NOT a fabricated metric: no customer counts, no
 * invented "saves X hours" numbers while we are in early access.
 */
function TrustBar() {
  const items = [
    { icon: DollarSign, label: 'Replaces a $2,400+/mo dispatcher' },
    { icon: Clock, label: 'Live in 15 minutes' },
    { icon: ShieldCheck, label: 'A second AI reviews every booking' },
    { icon: Check, label: 'Cancel anytime — keep your data' },
  ];
  return (
    <section className="border-b border-slate-800 bg-slate-900">
      <div className="mx-auto max-w-6xl px-6 pb-16">
        <ul className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
          {items.map((item) => (
            <li
              key={item.label}
              className="flex items-center gap-3 text-sm text-slate-200"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-slate-800 text-orange-400">
                <item.icon size={18} aria-hidden="true" />
              </span>
              <span className="font-medium">{item.label}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function ProblemSection() {
  return (
    <section className="border-b border-slate-200 bg-slate-50">
      <div className="mx-auto max-w-4xl px-6 py-20">
        <p className="text-center text-sm uppercase tracking-widest text-slate-500">
          The problem
        </p>
        <h2 className="mt-4 text-center text-3xl font-medium tracking-tight text-slate-900 sm:text-4xl">
          You learned the trade.
          <br />
          You did not sign up for everything else.
        </h2>
        <p className="mx-auto mt-6 max-w-2xl text-center text-base leading-relaxed text-slate-600">
          You&apos;re the dispatcher, the CSR, the estimator, the bookkeeper,
          the collections agent, and the marketing manager. You&apos;re also
          the one in the attic with the headlamp at 8 AM.
        </p>
        <p className="mx-auto mt-3 max-w-2xl text-center text-base leading-relaxed text-slate-600">
          Hiring someone to handle the office would cost $2,400+ a month.
          And nobody&apos;s available anyway.
        </p>
      </div>
    </section>
  );
}

function FeaturesSection() {
  const features = [
    {
      icon: Phone,
      title: 'Answers every call',
      body:
        'Rivet picks up in your shop&apos;s voice, books the job, and routes emergencies straight to you. Never another missed call on a 102&deg; day.',
    },
    {
      icon: FileText,
      title: 'Drafts your quotes',
      body:
        'From the call recording and your customer history, Rivet drafts the estimate. You approve or edit by tapping a single SMS.',
    },
    {
      icon: CreditCard,
      title: 'Chases your invoices',
      body:
        'Invoice goes out the moment the job is done. Friendly follow-ups go out on schedule until the customer pays. Time-to-cash drops.',
    },
    {
      icon: Moon,
      title: 'Tells you the truth',
      body:
        'Every evening, a one-text digest: what got done, what got paid, what I wasn&apos;t sure about today. The dashboard is a text message.',
    },
  ];
  return (
    <section className="border-b border-slate-200 bg-slate-50">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <div className="text-center">
          <p className="text-sm uppercase tracking-widest text-slate-500">
            What Rivet does
          </p>
          <h2 className="mt-4 text-3xl font-medium tracking-tight text-slate-900 sm:text-4xl">
            The whole back office, on autopilot.
          </h2>
        </div>
        <div className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {features.map((f) => (
            <div
              key={f.title}
              className="rounded-2xl border border-slate-200 bg-white p-6"
            >
              <div className="flex size-10 items-center justify-center rounded-xl bg-slate-900 text-white">
                <f.icon size={18} />
              </div>
              <h3 className="mt-5 text-base font-medium text-slate-900">
                {f.title}
              </h3>
              <p
                className="mt-2 text-sm leading-relaxed text-slate-600"
                dangerouslySetInnerHTML={{ __html: f.body }}
              />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function ComparisonSection() {
  const rows = [
    {
      time: '5:45 AM',
      without: '6 missed calls overnight. Three from the same number — probably an emergency you lost to a competitor.',
      with: 'One text: "7 calls overnight, 4 booked. 1 needs your call — Mrs. Alvarez, no AC, 2 small kids."',
    },
    {
      time: '8:00 AM',
      without: 'In the attic. Phone is ringing in your pocket. You can\'t answer.',
      with: 'In the attic. Phone buzzes once with a summary. You work.',
    },
    {
      time: '12:30 PM',
      without: 'Trying to write a quote one-handed in the truck. Can\'t remember the model number.',
      with: 'Quote is already drafted — built from the call and the customer\'s prior service. Tap to approve.',
    },
    {
      time: '4:30 PM',
      without: '"My AC just stopped, 104 in here, my mom is on oxygen." You\'re two hours away.',
      with: 'Rivet flags the call as emergency + medical and surfaces it at the top of your inbox with the urgency notes — so you see it the moment you check your phone, not buried at the bottom of the call list.',
    },
    {
      time: '9:30 PM',
      without: 'Office hours begin. Three estimates, four invoices, two follow-ups, schedule tomorrow.',
      with: 'End-of-day digest. Tap "looks good." Read your kid a story.',
    },
  ];
  return (
    <section className="border-b border-slate-200 bg-white">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <div className="text-center">
          <p className="text-sm uppercase tracking-widest text-slate-500">
            A Tuesday in August
          </p>
          <h2 className="mt-4 text-3xl font-medium tracking-tight text-slate-900 sm:text-4xl">
            Same day. Different operator.
          </h2>
        </div>
        <div className="mt-14 overflow-hidden rounded-2xl border border-slate-200 bg-slate-50">
          <div className="grid grid-cols-1 border-b border-slate-200 bg-slate-100 text-xs font-medium uppercase tracking-wider text-slate-500 sm:grid-cols-[100px_1fr_1fr]">
            <div className="hidden p-4 sm:block">Time</div>
            <div className="border-l border-slate-200 p-4 sm:border-l">Without Rivet</div>
            <div className="border-l border-slate-200 p-4">With Rivet</div>
          </div>
          {rows.map((row, i) => (
            <div
              key={row.time}
              className={
                'grid grid-cols-1 sm:grid-cols-[100px_1fr_1fr] ' +
                (i < rows.length - 1 ? 'border-b border-slate-200' : '')
              }
            >
              <div className="px-4 pt-4 pb-1 text-sm font-medium text-slate-900 sm:py-5">
                {row.time}
              </div>
              <div className="border-slate-200 px-4 pb-2 pt-1 text-sm leading-relaxed text-slate-600 sm:border-l sm:py-5">
                {row.without}
              </div>
              <div className="border-l-2 border-l-green-500 bg-green-50/50 px-4 pb-4 pt-2 text-sm leading-relaxed text-slate-700 sm:border-l sm:border-l-slate-200 sm:bg-transparent sm:py-5">
                {row.with}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function HowItWorksSection() {
  const steps = [
    {
      n: '1',
      title: 'Sign up &amp; pick your trade',
      body:
        'HVAC or plumbing. We seed your job types, message templates, and pricing in seconds.',
    },
    {
      n: '2',
      title: 'Forward your business line',
      body:
        'We provision you a local phone number. Forward your line in 5 minutes. Rivet starts answering immediately.',
    },
    {
      n: '3',
      title: 'Review approvals by SMS',
      body:
        'Every quote, invoice, and follow-up arrives as a single text with Approve / Edit / Reject. No app to open.',
    },
  ];
  return (
    <section id="how" className="border-b border-slate-200 bg-white">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <div className="text-center">
          <p className="text-sm uppercase tracking-widest text-slate-500">
            How it works
          </p>
          <h2 className="mt-4 text-3xl font-medium tracking-tight text-slate-900 sm:text-4xl">
            Live in 15 minutes.
          </h2>
        </div>
        <div className="mt-14 grid gap-8 md:grid-cols-3">
          {steps.map((s) => (
            <div key={s.n} className="relative">
              <div className="flex size-10 items-center justify-center rounded-xl bg-slate-900 text-base font-medium text-white">
                {s.n}
              </div>
              <h3
                className="mt-5 text-lg font-medium text-slate-900"
                dangerouslySetInnerHTML={{ __html: s.title }}
              />
              <p className="mt-2 text-sm leading-relaxed text-slate-600">
                {s.body}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function TrustSection() {
  const pillars = [
    {
      title: 'Rivet tells you when it\'s unsure',
      body:
        'Low-confidence parts, anomalous prices, and unverified accounts are flagged before they reach your customer.',
    },
    {
      title: 'A second AI reviews every booking',
      body:
        'A supervisor agent re-checks every quote and booking for missed urgency, pricing anomalies, and brand-voice drift — within 60 seconds.',
    },
    {
      title: 'AI never discounts or commits for you',
      body:
        'Scope changes, refunds, and "let me talk to your manager" requests always route through you with a recommendation.',
    },
    {
      title: 'The digest tells you what it got wrong',
      body:
        'Every evening, a "what I wasn\'t sure about today" section. No other AI receptionist will do this.',
    },
  ];
  return (
    <section className="border-b border-slate-200 bg-slate-900 text-white">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <div className="text-center">
          <p className="text-sm uppercase tracking-widest text-slate-400">
            Why operators trust it
          </p>
          <h2 className="mt-4 text-3xl font-medium tracking-tight sm:text-4xl">
            The AI that tells you when it&apos;s wrong.
          </h2>
          <p className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-slate-300">
            Every AI receptionist on the market hides its mistakes.
            We surface them. That&apos;s how trust gets built.
          </p>
        </div>
        <div className="mt-14 grid gap-6 md:grid-cols-2">
          {pillars.map((p) => (
            <div
              key={p.title}
              className="rounded-2xl border border-slate-800 bg-slate-800/50 p-6"
            >
              <div className="flex items-start gap-3">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-slate-700">
                  <Check size={16} className="text-green-400" />
                </div>
                <div>
                  <h3 className="text-base font-medium">{p.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-slate-300">
                    {p.body}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function PricingSection() {
  const included = [
    'Unlimited inbound calls and SMS',
    'AI quoting from call recordings + customer history',
    'AI invoicing and payment chasing',
    'End-of-day digest by text',
    'Google review monitoring &amp; draft responses',
    'One local US phone number included',
    '500 AI voice minutes / month included ($0.30/min after)',
    'Audit trail of every AI action',
  ];
  return (
    <section id="pricing" className="border-b border-slate-200 bg-slate-50">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <div className="text-center">
          <p className="text-sm uppercase tracking-widest text-slate-500">
            Pricing
          </p>
          <h2 className="mt-4 text-3xl font-medium tracking-tight text-slate-900 sm:text-4xl">
            One price. Everything.
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-base text-slate-600">
            Less than a tank of gas a day. A fraction of what a part-time
            dispatcher costs.
          </p>
        </div>
        <div className="mx-auto mt-12 max-w-lg">
          <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
            <div className="bg-slate-900 px-8 py-8 text-center text-white">
              <p className="text-sm uppercase tracking-widest text-slate-400">
                Rivet
              </p>
              <div className="mt-4 flex items-baseline justify-center">
                <span className="text-5xl font-medium tracking-tight">$297</span>
                <span className="ml-2 text-base text-slate-400">/ month</span>
              </div>
              <p className="mt-3 text-sm text-slate-300">
                14-day free trial &middot; Card held, nothing charged until day 15
              </p>
            </div>
            <div className="px-8 py-8">
              <ul className="space-y-3">
                {included.map((item) => (
                  <li key={item} className="flex items-start gap-3 text-sm text-slate-700">
                    <Check size={16} className="mt-0.5 shrink-0 text-green-600" />
                    <span dangerouslySetInnerHTML={{ __html: item }} />
                  </li>
                ))}
              </ul>
              <Link to="/signup" className="mt-7 block" onClick={onPricingCtaClick}>
                <Button variant="brand" size="lg" fullWidth rightIcon={<ArrowRight size={16} />}>
                  Start free trial
                </Button>
              </Link>
              <p className="mt-3 text-center text-xs text-slate-500">
                Cancel any time. Keep your data.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function FAQSection() {
  const faqs = [
    {
      q: 'Will my customers know it\'s an AI?',
      a: 'Rivet answers in your shop\'s voice with the name you give it (e.g. "M&R Mechanical\'s office"). Most customers do not notice. The voice quality is high. If a caller asks directly, we are honest about it.',
    },
    {
      q: 'What if the AI makes a mistake?',
      a: 'Nothing irreversible is sent without your approval. Every quote, invoice, and follow-up arrives in your phone as an SMS with Approve / Edit / Reject. Rivet also surfaces its own uncertainty — low-confidence parts and pricing anomalies are flagged before they reach you.',
    },
    {
      q: 'Do I have to log into a dashboard every day?',
      a: 'No. The dashboard is a daily text message. The web app exists for setup, audit, and the occasional deep dive — not for daily work.',
    },
    {
      q: 'What about emergencies?',
      a: 'Vulnerability and urgency signals (medical mentions, extreme weather, water damage in progress) flag the call at the top of your inbox with the urgency notes — so a high-risk caller never sits behind a tire-kicker. Automatic patch-through to your cell is on the roadmap.',
    },
    {
      q: 'What integrations do you have?',
      a: 'Twilio for voice and SMS. Stripe for invoicing and payments. Google Business Profile for review monitoring. Google Calendar for availability. SendGrid for email. Clerk for authentication. QuickBooks deep sync is on the roadmap.',
    },
    {
      q: 'Can I cancel?',
      a: 'Yes, any time. We export your data on request. We do not lock you in.',
    },
  ];
  return (
    <section id="faq" className="border-b border-slate-200 bg-white">
      <div className="mx-auto max-w-3xl px-6 py-20">
        <div className="text-center">
          <p className="text-sm uppercase tracking-widest text-slate-500">FAQ</p>
          <h2 className="mt-4 text-3xl font-medium tracking-tight text-slate-900 sm:text-4xl">
            Honest answers.
          </h2>
        </div>
        <dl className="mt-14 space-y-8">
          {faqs.map((f) => (
            <div key={f.q} className="border-b border-slate-200 pb-8 last:border-b-0">
              <dt className="text-base font-medium text-slate-900">{f.q}</dt>
              <dd className="mt-3 text-sm leading-relaxed text-slate-600">{f.a}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

function FinalCTASection() {
  return (
    <section className="bg-slate-50">
      <div className="mx-auto max-w-3xl px-6 py-20 text-center">
        <h2 className="text-3xl font-medium tracking-tight text-slate-900 sm:text-4xl">
          Stop dispatching from the attic.
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-base text-slate-600">
          14-day free trial. Card held, nothing charged until day 15. Live in 15 minutes.
        </p>
        <div className="mt-8 flex items-center justify-center gap-3">
          <Link to="/signup" onClick={onCtaClick('final_cta')}>
            <Button variant="brand" size="lg" rightIcon={<ArrowRight size={16} />}>
              Start free trial
            </Button>
          </Link>
          <Link to="/login">
            <Button variant="outline" size="lg">Log in</Button>
          </Link>
        </div>
      </div>
    </section>
  );
}

/**
 * Persistent mobile-only signup bar. On a long landing page the hero CTA
 * scrolls away fast on a phone; this keeps the single highest-intent action one
 * thumb-tap away without crowding the desktop layout (hidden at ≥sm, where the
 * sticky header CTA is always visible). ≥44px glove target.
 */
function StickyMobileCTA() {
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 p-3 backdrop-blur sm:hidden">
      <Link to="/signup" className="block" onClick={onCtaClick('sticky')}>
        <Button
          variant="brand"
          size="lg"
          fullWidth
          className="min-h-11"
          rightIcon={<ArrowRight size={16} />}
        >
          Start 14-day free trial
        </Button>
      </Link>
    </div>
  );
}

function MobileAppSection() {
  return (
    <section className="border-b border-slate-200 bg-white">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <div className="grid items-center gap-12 md:grid-cols-2">
          <div>
            <div className="flex size-10 items-center justify-center rounded-xl bg-slate-900 text-white">
              <Smartphone size={18} />
            </div>
            <h2 className="mt-5 text-3xl font-medium tracking-tight text-slate-900 sm:text-4xl">
              Run it from your pocket.
            </h2>
            <p className="mt-4 max-w-md text-base leading-relaxed text-slate-600">
              The Rivet app for iPhone and Android puts approvals, your money
              dashboard, and one-tap voice capture in your pocket. Speak an
              action between jobs — Rivet drafts the rest.
            </p>
            <div className="mt-8">
              <StoreBadges />
            </div>
            <p className="mt-4 text-xs text-slate-500">
              Sign up on the web in 15 minutes, then sign in on the app.
            </p>
          </div>
          <div className="rounded-3xl border border-slate-200 bg-slate-50 p-8">
            <ul className="space-y-4">
              {[
                'Speak an action and approve the draft in one tap',
                'See today’s revenue and what’s waiting on you',
                'Recordings queue offline and send when you’re back in range',
              ].map((item) => (
                <li key={item} className="flex items-start gap-3 text-sm text-slate-700">
                  <Check size={16} className="mt-0.5 shrink-0 text-green-600" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

export function LandingTrustBadge() {
  return (
    <div className="inline-flex items-center gap-2 rounded-full bg-amber-50 px-3 py-1 text-xs text-amber-700">
      <AlertCircle size={12} />
      Early access &mdash; built for owner-operators
    </div>
  );
}

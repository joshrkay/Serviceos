import { useEffect } from 'react';
import { Link } from 'react-router';
import { Check, ArrowRight } from 'lucide-react';
import { Button } from '../ui/button';
import { track, trackFunnel } from '../../lib/analytics';

const INCLUDED = [
  'Unlimited inbound calls and SMS',
  'AI quoting from call recordings + customer history',
  'AI invoicing and automatic payment chasing',
  'End-of-day digest by text',
  'Google review monitoring & draft responses',
  'One local US phone number included',
  '500 AI voice minutes / month included ($0.30/min after)',
  'Full audit trail of every AI action',
];

const WHY_ONE_PRICE = [
  {
    title: 'No “which plan?” paralysis',
    body:
      'One tier, everything included. You never have to guess whether the feature you need is on the plan you picked.',
  },
  {
    title: 'Priced against a dispatcher',
    body:
      'A part-time dispatcher costs $2,400+ a month. One lost emergency job costs $500–$1,500. Rivet is less than a tank of gas a day.',
  },
  {
    title: 'Cancel anytime',
    body:
      'No annual lock-in, no setup fee. Cancel whenever you want and export your data on request.',
  },
];

const FAQS = [
  {
    q: 'How does the free trial work?',
    a: 'You start a 14-day free trial with a card on file. Nothing is charged until day 15. If Rivet isn’t earning its keep, cancel before then and you won’t pay a cent.',
  },
  {
    q: 'What counts as a voice minute?',
    a: 'Any minute Rivet spends on a live call. 500 minutes a month are included — well above the median shop’s usage — and it’s $0.30/min after that. Most operators never hit the cap.',
  },
  {
    q: 'Are there setup or onboarding fees?',
    a: 'No. Self-serve setup takes about 15 minutes. White-glove onboarding is available at no extra charge during launch.',
  },
  {
    q: 'What do I need to pay for separately?',
    a: 'Nothing to get started — your phone number, calls, SMS, and invoicing are included. Card-payment processing uses standard Stripe fees, paid by you only when you collect money.',
  },
];

export function PricingPage() {
  useEffect(() => {
    trackFunnel('view_pricing');
  }, []);

  return (
    <>
      <section className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-4xl px-6 py-20 text-center">
          <p className="text-sm uppercase tracking-widest text-slate-500">Pricing</p>
          <h1 className="mt-4 text-4xl font-medium tracking-tight text-slate-900 sm:text-5xl">
            One price. Everything.
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-slate-600">
            Less than a tank of gas a day. A fraction of what a part-time
            dispatcher costs — and it works every hour you don’t.
          </p>
        </div>
      </section>

      <section className="border-b border-slate-200 bg-slate-50">
        <div className="mx-auto max-w-lg px-6 py-20">
          <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
            <div className="bg-slate-900 px-8 py-8 text-center text-white">
              <p className="text-sm uppercase tracking-widest text-slate-400">Rivet</p>
              <div className="mt-4 flex items-baseline justify-center">
                <span className="text-5xl font-medium tracking-tight">$297</span>
                <span className="ml-2 text-base text-slate-400">/ month</span>
              </div>
              <p className="mt-3 text-sm text-slate-300">
                14-day free trial · Card held, nothing charged until day 15
              </p>
            </div>
            <div className="px-8 py-8">
              <ul className="space-y-3">
                {INCLUDED.map((item) => (
                  <li
                    key={item}
                    className="flex items-start gap-3 text-sm text-slate-700"
                  >
                    <Check size={16} className="mt-0.5 shrink-0 text-green-600" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
              <Link
                to="/signup"
                className="mt-7 block"
                onClick={() => track('pricing_cta_clicked', { location: 'pricing_page' })}
              >
                <Button
                  variant="primary"
                  size="lg"
                  fullWidth
                  rightIcon={<ArrowRight size={16} />}
                >
                  Start free trial
                </Button>
              </Link>
              <p className="mt-3 text-center text-xs text-slate-500">
                Cancel any time. Keep your data.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-5xl px-6 py-20">
          <div className="grid gap-6 md:grid-cols-3">
            {WHY_ONE_PRICE.map((item) => (
              <div
                key={item.title}
                className="rounded-2xl border border-slate-200 bg-slate-50 p-6"
              >
                <h2 className="text-base font-medium text-slate-900">{item.title}</h2>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">{item.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-b border-slate-200 bg-slate-50">
        <div className="mx-auto max-w-3xl px-6 py-20">
          <div className="text-center">
            <p className="text-sm uppercase tracking-widest text-slate-500">
              Pricing FAQ
            </p>
            <h2 className="mt-4 text-3xl font-medium tracking-tight text-slate-900 sm:text-4xl">
              The fine print, in plain English.
            </h2>
          </div>
          <dl className="mt-12 space-y-8">
            {FAQS.map((f) => (
              <div
                key={f.q}
                className="border-b border-slate-200 pb-8 last:border-b-0"
              >
                <dt className="text-base font-medium text-slate-900">{f.q}</dt>
                <dd className="mt-3 text-sm leading-relaxed text-slate-600">{f.a}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>
    </>
  );
}

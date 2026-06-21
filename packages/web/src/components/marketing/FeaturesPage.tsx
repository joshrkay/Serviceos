import { useEffect } from 'react';
import {
  Phone,
  FileText,
  CreditCard,
  Moon,
  Star,
  ShieldCheck,
  Check,
} from 'lucide-react';
import { trackFunnel } from '../../lib/analytics';
import { MarketingCTA } from './MarketingCTA';

const PILLARS = [
  {
    icon: Phone,
    title: 'Answers every call',
    body:
      'Rivet picks up in your shop’s voice, qualifies the caller, books the job on your calendar, and routes emergencies straight to you. No more missed calls on a 102° day while you’re in the attic.',
    points: [
      'Unlimited inbound calls, 24/7',
      'Books straight onto your calendar',
      'Flags emergencies and vulnerable callers to the top of your inbox',
    ],
  },
  {
    icon: FileText,
    title: 'Drafts your quotes',
    body:
      'From the call recording and the customer’s service history, Rivet drafts the estimate with line items priced from your own catalog. You approve or edit by tapping a single SMS.',
    points: [
      'Prices grounded in your price book — never an invented number',
      'Approve, edit, or reject from one text',
      'Low-confidence line items flagged before they reach the customer',
    ],
  },
  {
    icon: CreditCard,
    title: 'Chases your invoices',
    body:
      'The invoice goes out the moment the job is marked done. Friendly follow-ups go out on schedule until the customer pays. Your time-to-cash drops without you lifting a finger.',
    points: [
      'Stripe-powered invoicing and card payment',
      'Automatic, polite payment reminders',
      'See what’s collected and what’s still chasing at a glance',
    ],
  },
  {
    icon: Moon,
    title: 'Tells you the truth',
    body:
      'Every evening, one text: what got done, what got paid, and what Rivet wasn’t sure about today. The dashboard is a text message — no app to open unless you want to.',
    points: [
      'End-of-day digest by SMS',
      'A “what I wasn’t sure about today” section, every day',
      'Full audit trail of every AI action',
    ],
  },
  {
    icon: Star,
    title: 'Watches your reputation',
    body:
      'Rivet monitors your Google Business Profile, drafts on-brand responses to new reviews, and surfaces anything that needs a personal reply — so a one-star never sits unanswered.',
    points: [
      'Google review monitoring',
      'Draft responses in your voice',
      'Escalates the reviews that need you',
    ],
  },
  {
    icon: ShieldCheck,
    title: 'Never commits for you',
    body:
      'Scope changes, refunds, discounts, and “let me talk to your manager” requests always route through you with a recommendation. Nothing irreversible is sent without your approval.',
    points: [
      'A second AI re-checks every quote and booking within 60 seconds',
      'AI never discounts or commits on your behalf',
      'Human approval on every customer-facing action',
    ],
  },
];

const COMPARISON = [
  {
    player: 'ServiceTitan / Jobber',
    pitch: 'Field-service operations software',
    gap: 'You still answer the phone, write the quote, and chase the invoice. It’s software, not staff — and it needs a dispatcher to operate.',
  },
  {
    player: 'Housecall Pro',
    pitch: 'All-in-one home-service software',
    gap: 'Same story: the owner is still the one doing the back-office work after dark.',
  },
  {
    player: 'Rosie / Goodcall / Numa',
    pitch: 'AI receptionist',
    gap: 'Books an appointment and stops. Doesn’t quote, invoice, chase payment, or monitor reviews — and papers over its mistakes.',
  },
  {
    player: 'Rivet',
    pitch: 'AI back office',
    gap: 'Replaces the dispatcher, not the truck. Phone → quote → invoice → payment chase → reviews. You run the trade; Rivet runs the business side.',
    highlight: true,
  },
];

export function FeaturesPage() {
  useEffect(() => {
    trackFunnel('view_features');
  }, []);

  return (
    <>
      <section className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-4xl px-6 py-20 text-center">
          <p className="text-sm uppercase tracking-widest text-slate-500">Features</p>
          <h1 className="mt-4 text-4xl font-medium tracking-tight text-slate-900 sm:text-5xl">
            The whole back office, on autopilot.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-slate-600">
            Rivet answers the phone, drafts the quote, sends the invoice, chases
            payment, and watches your reviews — and surfaces only the 30-second
            decisions that actually need you.
          </p>
        </div>
      </section>

      <section className="border-b border-slate-200 bg-slate-50">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <div className="grid gap-6 md:grid-cols-2">
            {PILLARS.map((p) => (
              <div
                key={p.title}
                className="rounded-2xl border border-slate-200 bg-white p-7"
              >
                <div className="flex size-10 items-center justify-center rounded-xl bg-slate-900 text-white">
                  <p.icon size={18} />
                </div>
                <h2 className="mt-5 text-lg font-medium text-slate-900">{p.title}</h2>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">{p.body}</p>
                <ul className="mt-4 space-y-2">
                  {p.points.map((point) => (
                    <li
                      key={point}
                      className="flex items-start gap-2.5 text-sm text-slate-700"
                    >
                      <Check size={15} className="mt-0.5 shrink-0 text-green-600" />
                      <span>{point}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-5xl px-6 py-20">
          <div className="text-center">
            <p className="text-sm uppercase tracking-widest text-slate-500">
              How Rivet is different
            </p>
            <h2 className="mt-4 text-3xl font-medium tracking-tight text-slate-900 sm:text-4xl">
              Not software. Not just a receptionist.
            </h2>
          </div>
          <div className="mt-12 space-y-4">
            {COMPARISON.map((row) => (
              <div
                key={row.player}
                className={
                  'rounded-2xl border p-6 sm:flex sm:items-start sm:gap-6 ' +
                  (row.highlight
                    ? 'border-slate-900 bg-slate-900 text-white'
                    : 'border-slate-200 bg-slate-50')
                }
              >
                <div className="sm:w-56 sm:shrink-0">
                  <p
                    className={
                      'text-base font-medium ' +
                      (row.highlight ? 'text-white' : 'text-slate-900')
                    }
                  >
                    {row.player}
                  </p>
                  <p
                    className={
                      'mt-1 text-xs uppercase tracking-wide ' +
                      (row.highlight ? 'text-slate-400' : 'text-slate-500')
                    }
                  >
                    {row.pitch}
                  </p>
                </div>
                <p
                  className={
                    'mt-3 text-sm leading-relaxed sm:mt-0 ' +
                    (row.highlight ? 'text-slate-200' : 'text-slate-600')
                  }
                >
                  {row.gap}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <MarketingCTA location="features_page" />
    </>
  );
}

import { useEffect } from 'react';
import { Check } from 'lucide-react';
import { trackFunnel } from '../../lib/analytics';
import { MarketingCTA } from './MarketingCTA';

const FIT = [
  'Owner-operator HVAC or plumbing shop',
  '1–3 trucks, $200K–$1M in revenue',
  'No dedicated office manager — you are the office',
  'You carry a smartphone and dispatch from the truck',
];

const NOT_FIT = [
  '5+ employees with a dedicated office manager',
  'Already on ServiceTitan and happy with it',
  'Building toward a 20-truck fleet (different product)',
];

const BELIEFS = [
  {
    title: 'Replace the job, not the trade',
    body:
      'We don’t replace the person in the attic with the headlamp. We replace the dispatcher, the CSR, the estimator, the bookkeeper, and the collections agent — the jobs you never signed up for.',
  },
  {
    title: 'Tell the truth, especially when it’s wrong',
    body:
      'Every AI receptionist on the market hides its mistakes. Rivet surfaces them. The end-of-day digest has a “what I wasn’t sure about today” section. That’s how trust gets built.',
  },
  {
    title: 'You approve what matters',
    body:
      'Nothing irreversible goes out without your tap. Rivet drafts; you decide. Thirty seconds a day, not a second job after dark.',
  },
];

export function AboutPage() {
  useEffect(() => {
    trackFunnel('view_about');
  }, []);

  return (
    <>
      <section className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-3xl px-6 py-20 text-center">
          <p className="text-sm uppercase tracking-widest text-slate-500">About Rivet</p>
          <h1 className="mt-4 text-4xl font-medium tracking-tight text-slate-900 sm:text-5xl">
            You learned the trade.
            <br />
            We’ll run the business.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-slate-600">
            Rivet is the AI back office for solo home-service operators. It
            answers the phone in your shop’s voice, drafts quotes from the call,
            sends invoices when the job is done, and chases payment — surfacing
            only the decisions that actually need you.
          </p>
        </div>
      </section>

      <section className="border-b border-slate-200 bg-slate-50">
        <div className="mx-auto max-w-3xl px-6 py-20">
          <p className="text-sm uppercase tracking-widest text-slate-500">Why we built it</p>
          <h2 className="mt-4 text-3xl font-medium tracking-tight text-slate-900 sm:text-4xl">
            The dispatcher is the bottleneck.
          </h2>
          <div className="mt-6 space-y-4 text-base leading-relaxed text-slate-600">
            <p>
              Every owner we talked to was dispatching from inside a truck — or
              an attic — on the hottest day of the year. They lose at least one
              job a week to a missed call. Hiring someone to handle the office
              costs $2,400+ a month, and nobody’s available anyway.
            </p>
            <p>
              Ten years ago the answer was “hire a receptionist.” Today nobody
              can. But three things became true in the last 18 months: voice
              models can hold a real service conversation for under a dollar a
              minute, SMS + Stripe + Twilio can run an entire money flow end to
              end, and the labor crisis made the demand undeniable.
            </p>
            <p>
              So we built the thing an owner-operator actually needs: not more
              software to operate, but staff that operates itself.
            </p>
          </div>
        </div>
      </section>

      <section className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-5xl px-6 py-20">
          <div className="grid gap-6 md:grid-cols-3">
            {BELIEFS.map((b) => (
              <div
                key={b.title}
                className="rounded-2xl border border-slate-200 bg-slate-50 p-6"
              >
                <h3 className="text-base font-medium text-slate-900">{b.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">{b.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-b border-slate-200 bg-slate-50">
        <div className="mx-auto max-w-4xl px-6 py-20">
          <div className="text-center">
            <p className="text-sm uppercase tracking-widest text-slate-500">
              Who Rivet is for
            </p>
            <h2 className="mt-4 text-3xl font-medium tracking-tight text-slate-900 sm:text-4xl">
              Built for the 1–3 truck shop.
            </h2>
          </div>
          <div className="mt-12 grid gap-6 sm:grid-cols-2">
            <div className="rounded-2xl border border-slate-200 bg-white p-7">
              <h3 className="text-base font-medium text-slate-900">A great fit if…</h3>
              <ul className="mt-4 space-y-3">
                {FIT.map((item) => (
                  <li
                    key={item}
                    className="flex items-start gap-2.5 text-sm text-slate-700"
                  >
                    <Check size={15} className="mt-0.5 shrink-0 text-green-600" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-7">
              <h3 className="text-base font-medium text-slate-900">
                Probably not for you if…
              </h3>
              <ul className="mt-4 space-y-3">
                {NOT_FIT.map((item) => (
                  <li
                    key={item}
                    className="flex items-start gap-2.5 text-sm text-slate-600"
                  >
                    <span
                      aria-hidden
                      className="mt-0.5 flex size-[15px] shrink-0 items-center justify-center rounded-full bg-slate-200 text-[10px] text-slate-500"
                    >
                      ✕
                    </span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      <MarketingCTA location="about_page" />
    </>
  );
}

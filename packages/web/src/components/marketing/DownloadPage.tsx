import { useEffect } from 'react';
import { Mic, Inbox, LineChart, WifiOff } from 'lucide-react';
import { trackFunnel } from '../../lib/analytics';
import { StoreBadges } from './StoreBadges';
import { MarketingCTA } from './MarketingCTA';

const APP_FEATURES = [
  {
    icon: Mic,
    title: 'One-tap voice capture',
    body:
      'Speak an action between jobs — “just finished the Rodriguez job, bill 3 hours and the parts.” Rivet drafts the invoice for you to approve.',
  },
  {
    icon: Inbox,
    title: 'Approvals inbox',
    body:
      'Every quote, invoice, and follow-up waiting on you, with a live count. Approve, edit, or reject in a tap.',
  },
  {
    icon: LineChart,
    title: 'Money dashboard',
    body:
      'Today’s revenue, what’s been collected, and what’s still chasing — the numbers that matter, at a glance.',
  },
  {
    icon: WifiOff,
    title: 'Works in the field',
    body:
      'Recordings queue offline and upload the moment you’re back in range. The attic and the crawlspace don’t stop you.',
  },
];

export function DownloadPage() {
  useEffect(() => {
    trackFunnel('view_download');
  }, []);

  return (
    <>
      <section className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-4xl px-6 py-20 text-center">
          <p className="text-sm uppercase tracking-widest text-slate-500">
            Rivet for mobile
          </p>
          <h1 className="mt-4 text-4xl font-medium tracking-tight text-slate-900 sm:text-5xl">
            Run your shop from your pocket.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-slate-600">
            The Rivet app for iPhone and Android puts voice capture, approvals,
            and your money dashboard one tap away — wherever the job is.
          </p>
          <div className="mt-10 flex justify-center">
            <StoreBadges />
          </div>
          <p className="mt-5 text-sm text-slate-500">
            New to Rivet? Start your 14-day free trial on the web, then sign in
            on the app — your account works everywhere.
          </p>
        </div>
      </section>

      <section className="border-b border-slate-200 bg-slate-50">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {APP_FEATURES.map((f) => (
              <div
                key={f.title}
                className="rounded-2xl border border-slate-200 bg-white p-6"
              >
                <div className="flex size-10 items-center justify-center rounded-xl bg-slate-900 text-white">
                  <f.icon size={18} />
                </div>
                <h2 className="mt-5 text-base font-medium text-slate-900">{f.title}</h2>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <MarketingCTA
        location="download_page"
        heading="Set up in 15 minutes. Carry it everywhere."
        sub="Start your free trial on the web, then take Rivet with you on iOS and Android."
      />
    </>
  );
}

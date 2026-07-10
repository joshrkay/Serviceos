import type { Metadata } from 'next';
import { Section } from '@/components/Section';
import { pageMetadata } from '@/lib/metadata';
import {
  NURTURE_SEQUENCES,
  renderMergeFields,
  type MergeData,
  type NurtureEmail,
} from '@/lib/nurture/sequences';
import { getMailbox } from '@/lib/nurture/mailbox';
import { TEST_CONTACT_ALLOWLIST, GO_LIVE_UNLOCK } from '@/lib/nurture/allowlist';
import { FireTestEventForm } from './FireTestEventForm';

export const metadata: Metadata = pageMetadata({
  title: 'Nurture preview (internal)',
  description: 'Internal reviewer tool for the nurture email sequence catalog and demo mailbox.',
  path: '/nurture-preview',
});

// Internal review tool, not a marketing page — keep it out of search results.
export const dynamic = 'force-dynamic';

const SAMPLE_MERGE_DATA: MergeData = {
  first_name: 'Jenna',
  onboarding_url: 'https://app.rivet.example/onboarding',
  app_url: 'https://app.rivet.example',
  restart_url: 'https://rivet.example/signup',
  fix_payment_url: 'https://app.rivet.example/billing',
  calls_answered: '42',
  bookings_approved: '19',
  estimates_drafted: '11',
  invoices_sent: '9',
};

function delayLabel(email: NurtureEmail): string {
  return email.delayDays === 0 ? 'Immediate' : `+${email.delayDays}d`;
}

function triggerLabel(email: NurtureEmail): string {
  if (email.trigger === 'canceled_or_trial_expired') return 'canceled OR trial-expired-unconverted';
  return email.trigger;
}

function emailPreviewDoc(bodyHtml: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #0f172a; background: #ffffff; margin: 0; padding: 20px; line-height: 1.55; font-size: 15px; }
  p { margin: 0 0 14px; }
  ol, ul { margin: 0 0 14px; padding-left: 22px; }
  li { margin-bottom: 6px; }
  a { color: #2563eb; }
  strong { font-weight: 600; }
</style>
</head>
<body>${bodyHtml}</body>
</html>`;
}

export default function NurturePreviewPage() {
  const mailbox = getMailbox();

  return (
    <>
      <Section as="div" className="pt-24">
        <span className="eyebrow">Internal — not a marketing page</span>
        <h1 className="mt-3 font-display text-3xl font-bold text-fg sm:text-4xl">Nurture preview</h1>
        <p className="mt-4 max-w-2xl text-fg-muted">
          The full nurture sequence catalog wired to the site&apos;s lifecycle event bus, plus a
          live demo mailbox for this session. Sends are gated to a fixed test-contact allowlist —
          see the go-live note at the bottom.
        </p>

        <div className="mt-8 rounded-lg border border-border bg-surface p-6">
          <h2 className="text-lg font-semibold text-fg">Fire a test event</h2>
          <p className="mt-1 text-sm text-fg-muted">
            Fires <code className="rounded bg-surface-muted px-1 py-0.5">trial_started</code> for a
            test contact through the same lifecycle hook the real signup flow uses. Watch the
            welcome email (immediate, no delay) land in the mailbox below.
          </p>
          <div className="mt-4">
            <FireTestEventForm />
          </div>
        </div>
      </Section>

      <Section as="div">
        <h2 className="font-display text-2xl font-bold text-fg">Live mailbox (this session)</h2>
        <p className="mt-2 text-sm text-fg-muted">
          In-memory only — resets on every serverless cold start / dev-server restart. Nothing here
          is persisted to a database.
        </p>

        {mailbox.length === 0 ? (
          <p className="mt-6 rounded-lg border border-dashed border-border p-6 text-sm text-fg-muted">
            No sends yet this session. Fire a test event above to see the welcome email land here.
          </p>
        ) : (
          <ul className="mt-6 flex flex-col gap-3">
            {mailbox.map((entry) => (
              <li key={entry.id} className="rounded-lg border border-border bg-surface p-4">
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="font-semibold text-fg">{entry.subject}</span>
                  <span className="rounded bg-surface-muted px-2 py-0.5 text-xs uppercase tracking-wide text-fg-muted">
                    {entry.transport}
                  </span>
                </div>
                <p className="mt-1 text-sm text-fg-muted">
                  to <span className="font-mono">{entry.to}</span> · {entry.emailId} ·{' '}
                  {new Date(entry.at).toLocaleString()}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section as="div">
        <h2 className="font-display text-2xl font-bold text-fg">Sequence catalog</h2>
        <p className="mt-2 max-w-2xl text-sm text-fg-muted">
          All 8 emails, rendered with sample merge data. Merge fields render exactly as the engine
          renders them at send time (src/lib/nurture/sequences.ts renderMergeFields).
        </p>

        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          {NURTURE_SEQUENCES.map((email) => {
            const subject = renderMergeFields(email.subject, SAMPLE_MERGE_DATA);
            const previewText = renderMergeFields(email.previewText, SAMPLE_MERGE_DATA);
            const bodyHtml = renderMergeFields(email.bodyHtml, SAMPLE_MERGE_DATA);

            return (
              <article key={email.id} className="flex flex-col rounded-lg border border-border bg-surface p-5">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="rounded bg-surface-muted px-2 py-0.5 font-mono text-fg-muted">
                    {email.id}
                  </span>
                  <span className="rounded bg-surface-muted px-2 py-0.5 text-fg-muted">
                    trigger: {triggerLabel(email)}
                  </span>
                  <span className="rounded bg-surface-muted px-2 py-0.5 text-fg-muted">
                    delay: {delayLabel(email)}
                  </span>
                  {email.transactional && (
                    <span className="rounded bg-accent/20 px-2 py-0.5 text-fg-muted">transactional</span>
                  )}
                </div>

                <h3 className="mt-3 text-lg font-semibold text-fg">{subject}</h3>
                <p className="mt-1 text-sm italic text-fg-muted">{previewText}</p>

                <p className="mt-3 text-xs text-fg-muted">
                  <span className="font-semibold">Suppression:</span> {email.suppressionNote}
                </p>

                <div className="mt-4 overflow-hidden rounded border border-border bg-white">
                  <iframe
                    title={`${email.id} preview`}
                    srcDoc={emailPreviewDoc(bodyHtml)}
                    sandbox=""
                    className="h-80 w-full"
                  />
                </div>
              </article>
            );
          })}
        </div>
      </Section>

      <Section as="div" className="pb-24">
        <h2 className="font-display text-2xl font-bold text-fg">Go-live</h2>
        <div className="mt-4 rounded-lg border border-border bg-surface p-6 text-sm text-fg-muted">
          <p>
            <span className="font-semibold text-fg">Current allowlist</span> (send path only allows
            these addresses, regardless of transport):
          </p>
          <ul className="mt-2 list-disc pl-5">
            {TEST_CONTACT_ALLOWLIST.map((address) => (
              <li key={address} className="font-mono">
                {address}
              </li>
            ))}
          </ul>
          <p className="mt-4">
            <span className="font-semibold text-fg">GO_LIVE_UNLOCK</span> is currently{' '}
            <code className="rounded bg-surface-muted px-1 py-0.5">{String(GO_LIVE_UNLOCK)}</code>.
            Flipping it to <code className="rounded bg-surface-muted px-1 py-0.5">true</code> in{' '}
            <code className="rounded bg-surface-muted px-1 py-0.5">src/lib/nurture/allowlist.ts</code>{' '}
            is a deliberate human go-live action, taken only once a real{' '}
            <code className="rounded bg-surface-muted px-1 py-0.5">RESEND_API_KEY</code> is configured
            and someone has decided this build may email real prospects.
          </p>
        </div>
      </Section>
    </>
  );
}

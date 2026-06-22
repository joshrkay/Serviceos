import { LegalPage, type LegalSection } from './LegalPage';

const SECTIONS: LegalSection[] = [
  {
    heading: 'Who we are',
    paragraphs: [
      'Rivet provides an AI back-office service for home-service businesses — answering calls, drafting quotes, sending invoices, chasing payment, and monitoring reviews. This policy explains what we collect, why, and the choices you have.',
    ],
  },
  {
    heading: 'Information we collect',
    paragraphs: ['To operate the service, we process:'],
    bullets: [
      'Account data — your name, business name, email, and phone number, managed through our authentication provider (Clerk).',
      'Call and message content — recordings, transcripts, and SMS handled on your behalf through Twilio, used to draft quotes and summaries.',
      'Customer and job data you or your callers provide — names, addresses, service history, and pricing.',
      'Payment data — processed by Stripe; we store billing status and identifiers, never full card numbers.',
      'Connected-account data — Google Business Profile reviews and Google Calendar availability, only when you connect them.',
      'Usage and diagnostics — product analytics (PostHog) and error reports, used to keep the service reliable.',
    ],
  },
  {
    heading: 'How we use your information',
    bullets: [
      'To answer calls, draft quotes and invoices, and chase payment on your behalf.',
      'To produce your end-of-day digest and audit trail.',
      'To provide support, prevent abuse, and improve reliability and accuracy.',
      'To process billing for your subscription.',
    ],
    paragraphs: [
      'We do not sell your personal information, and we do not use your customers’ data to train third-party models for unrelated purposes.',
    ],
  },
  {
    heading: 'Sub-processors',
    paragraphs: [
      'We rely on a small set of vendors to deliver the service: Clerk (authentication), Twilio (voice and SMS), Stripe (payments), Google (reviews and calendar, when connected), SendGrid (email), an LLM provider for AI drafting, and our cloud host. Each processes data only to perform its function.',
    ],
  },
  {
    heading: 'Data retention',
    paragraphs: [
      'We keep your data for as long as your account is active and as needed to provide the service. On request we will export your data and, after account closure, delete it within a commercially reasonable period, except where we must retain records to meet legal obligations.',
    ],
  },
  {
    heading: 'Your choices and rights',
    bullets: [
      'Access, correct, or export your data on request.',
      'Disconnect any connected account (Google) at any time.',
      'Close your account and request deletion of your data.',
      'Control call recording disclosures consistent with your local laws.',
    ],
  },
  {
    heading: 'Security',
    paragraphs: [
      'Data is encrypted in transit, access is tenant-isolated, and every change to your records is recorded in an audit trail. No system is perfectly secure, but we work to protect your data and notify you of material incidents.',
    ],
  },
  {
    heading: 'Changes to this policy',
    paragraphs: [
      'We may update this policy as the service evolves. When we make material changes, we will update the date above and, where appropriate, notify you.',
    ],
  },
];

export function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      lastUpdated="June 21, 2026"
      intro="Your trust is the product. This policy describes the information Rivet collects, how we use it, and the control you have over it."
      sections={SECTIONS}
    />
  );
}

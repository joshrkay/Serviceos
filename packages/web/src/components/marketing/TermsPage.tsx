import { LegalPage, type LegalSection } from './LegalPage';

const SECTIONS: LegalSection[] = [
  {
    heading: 'Agreement to terms',
    paragraphs: [
      'These terms govern your use of Rivet. By creating an account or using the service, you agree to them. If you are using Rivet on behalf of a business, you represent that you have authority to bind that business.',
    ],
  },
  {
    heading: 'The service',
    paragraphs: [
      'Rivet is an AI back-office assistant for home-service businesses. It drafts quotes, invoices, messages, and call summaries for your review. You are responsible for approving customer-facing actions; nothing irreversible is sent without your approval.',
    ],
  },
  {
    heading: 'Your responsibilities',
    bullets: [
      'Provide accurate business and billing information.',
      'Use Rivet in compliance with applicable laws, including call-recording, telemarketing, and messaging regulations in your jurisdiction.',
      'Review AI-drafted output before it is sent to customers.',
      'Keep your login credentials secure and not share access beyond your authorized team.',
    ],
  },
  {
    heading: 'Free trial and billing',
    paragraphs: [
      'Rivet is offered at $297 per month. New accounts begin with a 14-day free trial; a payment method is held but nothing is charged until the trial ends. After the trial, the subscription renews monthly until cancelled.',
      'Included usage covers 500 AI voice minutes per month; additional minutes are billed at $0.30 per minute. Card-payment processing fees on money you collect are billed by Stripe at standard rates.',
      'You can cancel at any time. Cancellation stops future renewals; fees already incurred are non-refundable except where required by law.',
    ],
  },
  {
    heading: 'AI output and accuracy',
    paragraphs: [
      'Rivet uses AI to draft content and may make mistakes. We surface uncertainty rather than hide it, but you are responsible for reviewing and approving output. Rivet is a tool to assist your business judgment, not a substitute for it, and does not provide legal, tax, or professional advice.',
    ],
  },
  {
    heading: 'Acceptable use',
    bullets: [
      'Do not use Rivet for unlawful, deceptive, or abusive purposes.',
      'Do not attempt to disrupt, reverse-engineer, or gain unauthorized access to the service.',
      'Do not use Rivet to send communications that violate anti-spam or consent laws.',
    ],
  },
  {
    heading: 'Your data',
    paragraphs: [
      'You retain ownership of your business and customer data. You grant us the rights needed to operate the service on your behalf. Our handling of personal information is described in the Privacy Policy.',
    ],
  },
  {
    heading: 'Disclaimers and liability',
    paragraphs: [
      'The service is provided “as is.” To the maximum extent permitted by law, Rivet disclaims implied warranties and is not liable for indirect or consequential damages. Our total liability for any claim is limited to the fees you paid in the three months before the claim.',
    ],
  },
  {
    heading: 'Termination',
    paragraphs: [
      'You may stop using Rivet and close your account at any time. We may suspend or terminate access for violations of these terms or to protect the service and its users. On termination you may request an export of your data.',
    ],
  },
  {
    heading: 'Changes to these terms',
    paragraphs: [
      'We may update these terms as the service evolves. Material changes will be reflected in the date above and, where appropriate, communicated to you. Continued use after a change constitutes acceptance.',
    ],
  },
];

export function TermsPage() {
  return (
    <LegalPage
      title="Terms of Service"
      lastUpdated="June 21, 2026"
      intro="These terms are the agreement between you and Rivet. We’ve kept them as plain as we can."
      sections={SECTIONS}
    />
  );
}

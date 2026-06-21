import { LegalPage, LegalSection } from './LegalPage';

/**
 * Public terms of service (`/terms`). DRAFT copy — reviewed by counsel before
 * launch. Linked from the marketing footer and referenced at signup.
 */
export function TermsOfService() {
  return (
    <LegalPage title="Terms of Service" lastUpdated="June 21, 2026">
      <p>
        These Terms govern your use of Rivet. By creating an account or using the
        service, you agree to them. If you are using Rivet on behalf of a
        business, you represent that you are authorized to bind that business.
      </p>

      <LegalSection heading="The service">
        <p>
          Rivet provides software to help home-service businesses capture work by
          voice, draft estimates and invoices, schedule jobs, and communicate with
          their customers. AI features draft proposed actions; you remain
          responsible for reviewing and approving them before they take effect.
        </p>
      </LegalSection>

      <LegalSection heading="Accounts and eligibility">
        <p>
          You must provide accurate information, keep your credentials secure, and
          be responsible for activity under your account. You must be at least 18
          and able to form a binding contract.
        </p>
      </LegalSection>

      <LegalSection heading="Subscription and billing">
        <p>
          Rivet is offered as a subscription (currently $297/month) with a free
          trial. Unless stated otherwise, fees are billed in advance and are
          non-refundable except where required by law. You may cancel at any time;
          cancellation stops future renewals and takes effect at the end of the
          current billing period. We may change pricing with notice.
        </p>
      </LegalSection>

      <LegalSection heading="Acceptable use">
        <p>
          You agree not to misuse the service: no unlawful activity, no sending
          messages or placing calls without the recipient's required consent
          (including compliance with applicable telemarketing and anti-spam laws),
          no infringement, no attempts to disrupt or gain unauthorized access, and
          no use that violates the rights of others.
        </p>
      </LegalSection>

      <LegalSection heading="Your data and ownership">
        <p>
          You retain ownership of the business and customer data you put into
          Rivet. You grant us the limited rights needed to operate the service for
          you (for example, to transcribe audio and generate proposals). You are
          responsible for having the rights and consents needed for the data and
          communications you process through Rivet.
        </p>
      </LegalSection>

      <LegalSection heading="AI-generated content">
        <p>
          Rivet uses AI to draft estimates, messages, and other proposed actions.
          These drafts may contain errors and are provided for your review. Money,
          customer communications, and other consequential actions require your
          explicit approval, and you are responsible for what you approve.
        </p>
      </LegalSection>

      <LegalSection heading="Disclaimers and limitation of liability">
        <p>
          The service is provided "as is" without warranties of any kind to the
          fullest extent permitted by law. To the maximum extent permitted by law,
          Rivet is not liable for indirect, incidental, or consequential damages,
          and our total liability is limited to the amounts you paid us in the 12
          months before the claim.
        </p>
      </LegalSection>

      <LegalSection heading="Termination">
        <p>
          You may stop using and delete your account at any time. We may suspend or
          terminate access for violation of these Terms or to protect the service.
        </p>
      </LegalSection>

      <LegalSection heading="Governing law and contact">
        <p>
          These Terms are governed by the laws of the United States and the state
          in which Rivet is established, without regard to conflict-of-laws rules.
          Questions: <a className="text-slate-900 underline" href="mailto:support@rivet.ai">support@rivet.ai</a>.
        </p>
      </LegalSection>
    </LegalPage>
  );
}

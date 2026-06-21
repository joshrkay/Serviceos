import { LegalPage, LegalSection } from './LegalPage';

/**
 * Public privacy policy (`/privacy`). DRAFT copy — reviewed by counsel before
 * launch. Reachable URL required for App Store Connect's privacy field and for
 * the App Privacy "nutrition labels"; this page must stay in sync with what the
 * app actually collects.
 */
export function PrivacyPolicy() {
  return (
    <LegalPage title="Privacy Policy" lastUpdated="June 21, 2026">
      <p>
        Rivet ("Rivet", "we", "us") provides software that helps home-service
        businesses run their operations — capturing work by voice, drafting
        estimates and invoices, scheduling jobs, and communicating with their
        customers. This policy explains what we collect, why, and the choices you
        have. It covers the Rivet web app and the Rivet mobile apps.
      </p>

      <LegalSection heading="Information we collect">
        <p>
          <strong>Account information.</strong> When you sign up we collect your
          name, email, phone number, business name, and authentication details.
          Authentication is handled by our identity provider (Clerk).
        </p>
        <p>
          <strong>Business and customer data you enter.</strong> As you use Rivet
          you (the operator) create records about your own customers — names,
          phone numbers, email and service addresses, job details, estimates,
          invoices, and payment status. You are responsible for the information
          you enter about your customers.
        </p>
        <p>
          <strong>Voice recordings and transcripts.</strong> When you use voice
          capture or our calling features, we process audio to transcribe it and
          draft proposed actions. Transcripts are stored encrypted at rest.
        </p>
        <p>
          <strong>Usage and device information.</strong> We collect logs, device
          and app version, and basic analytics events to operate and improve the
          service.
        </p>
        <p>
          <strong>Payments.</strong> Subscription and customer payments are
          processed by Stripe. We do not store full card numbers; Stripe handles
          card data under its own terms.
        </p>
      </LegalSection>

      <LegalSection heading="How we use information">
        <p>
          To provide and operate the service; to transcribe voice and draft
          proposals you then review and approve; to send notifications and
          messages you initiate; to process billing; to provide support; to
          secure the service and prevent abuse; and to comply with law.
        </p>
        <p>
          AI features draft proposed actions only. Money, communications, and
          other consequential actions always require your explicit human
          approval before they take effect.
        </p>
      </LegalSection>

      <LegalSection heading="How we share information">
        <p>
          We do not sell your personal information. We share data with service
          providers ("subprocessors") who process it on our behalf, including:
          Clerk (authentication), Stripe (payments), Twilio (telephony and SMS),
          our AI/transcription provider, and our cloud hosting provider. We may
          also disclose information to comply with law or to protect rights and
          safety.
        </p>
      </LegalSection>

      <LegalSection heading="Data retention and deletion">
        <p>
          We retain your data while your account is active. You can permanently
          delete your account and its associated data at any time from within the
          mobile app (Settings → Delete account) or by contacting us. Deletion is
          permanent and removes your tenant's records; some records may persist in
          backups for a limited period and in logs we are required to keep.
        </p>
      </LegalSection>

      <LegalSection heading="Security">
        <p>
          We use industry-standard measures including encryption in transit,
          encryption at rest for sensitive data such as voice transcripts, and
          strict per-business data isolation. No method of transmission or storage
          is perfectly secure.
        </p>
      </LegalSection>

      <LegalSection heading="Children's privacy">
        <p>
          Rivet is a business tool and is not directed to children under 13, and
          we do not knowingly collect their information.
        </p>
      </LegalSection>

      <LegalSection heading="Changes and contact">
        <p>
          We may update this policy and will revise the date above. Questions or
          requests: <a className="text-slate-900 underline" href="mailto:privacy@rivet.ai">privacy@rivet.ai</a>.
        </p>
      </LegalSection>
    </LegalPage>
  );
}

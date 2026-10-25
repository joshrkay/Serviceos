/**
 * Real-shaped provider webhook bodies carrying a customer's (or, for Clerk, a
 * staff member's) personal data, for the `webhook_events` minimization tests.
 *
 * Every personal value is one of {@link PII_MARKERS}, so a test can assert that
 * a stored payload holds none of them with one text search (`assertNoPii`)
 * instead of naming each key. The shapes follow the providers' documented
 * objects: Stripe's event `data` (what the Stripe route stores), Clerk's svix
 * envelope, Twilio's form-encoded callback fields and a SendGrid event batch.
 */

export const PII = {
  email: 'jane.erasure@example.com',
  name: 'Jane Erasure',
  firstName: 'Jane',
  lastName: 'Erasure',
  phone: '+15125550147',
  ownerPhone: '+15125550199',
  street: '1600 Erasure Lane',
  city: 'Pflugerville',
  postalCode: '78699',
  smsBody: 'my sink at 1600 Erasure Lane is flooding',
  mediaUrl: 'https://api.twilio.com/2010-04-01/Accounts/ACpii/Messages/MMpii/Media/MEpii-photo',
  ip: '203.0.113.77',
  userAgent: 'PiiBrowser/9.9',
  description: 'Water heater install for Jane Erasure',
  gateCode: 'gate code 4417',
} as const;

/** Every value above: none may appear in a stored receipt. */
export const PII_MARKERS: readonly string[] = Object.values(PII);

/**
 * Returns the markers found in `value`'s JSON text (empty when clean). A
 * serialized Buffer (`{ type: 'Buffer', data: [...] }`, how the SendGrid route
 * once stored its raw body) is decoded first, so bytes can't hide a marker.
 */
export function findPii(value: unknown): string[] {
  const text =
    JSON.stringify(value, (_key, v: unknown) => {
      const b = v as { type?: unknown; data?: unknown } | null;
      return b && typeof b === 'object' && b.type === 'Buffer' && Array.isArray(b.data)
        ? Buffer.from(b.data as number[]).toString('utf8')
        : v;
    }) ?? '';
  return PII_MARKERS.filter((m) => text.includes(m));
}

const address = {
  line1: PII.street,
  line2: 'Unit 2',
  city: PII.city,
  state: 'TX',
  postal_code: PII.postalCode,
  country: 'US',
};

const billingDetails = { email: PII.email, name: PII.name, phone: PII.phone, address };

export interface StripeFixtureIds {
  tenantId: string;
  invoiceId: string;
}

/** `event.data` of a `checkout.session.completed` for an invoice pay link. */
export function stripeCheckoutSessionData(
  ids: StripeFixtureIds & { amountTotal: number; paymentIntent?: string | Record<string, unknown> | null },
): Record<string, unknown> {
  return {
    object: {
      id: `cs_test_${ids.invoiceId.slice(0, 8)}`,
      object: 'checkout.session',
      amount_subtotal: ids.amountTotal,
      amount_total: ids.amountTotal,
      currency: 'usd',
      created: 1_790_000_000,
      expires_at: 1_790_086_400,
      livemode: false,
      mode: 'payment',
      payment_status: 'paid',
      status: 'complete',
      customer: null,
      ...(ids.paymentIntent === undefined ? {} : { payment_intent: ids.paymentIntent }),
      metadata: { tenant_id: ids.tenantId, invoice_id: ids.invoiceId, free_text_note: PII.gateCode },
      customer_email: PII.email,
      customer_details: { ...billingDetails, tax_exempt: 'none', tax_ids: [] },
      shipping_details: { name: PII.name, address },
      collected_information: { shipping_details: { name: PII.name, address } },
      custom_fields: [{ key: 'notes', text: { value: PII.gateCode } }],
      client_reference_id: PII.email,
      success_url: `https://pay.example.com/thanks?email=${PII.email}`,
    },
  };
}

export function stripePaymentIntentData(ids: StripeFixtureIds): Record<string, unknown> {
  return {
    object: {
      id: 'pi_fixture_1',
      object: 'payment_intent',
      amount: 45000,
      amount_received: 45000,
      currency: 'usd',
      created: 1_790_000_100,
      livemode: false,
      status: 'requires_payment_method',
      customer: { id: 'cus_fixture_1', object: 'customer', email: PII.email, name: PII.name, phone: PII.phone },
      latest_charge: 'ch_fixture_1',
      payment_method: 'pm_fixture_1',
      metadata: { tenant_id: ids.tenantId, invoice_id: ids.invoiceId },
      receipt_email: PII.email,
      description: PII.description,
      shipping: { name: PII.name, phone: PII.phone, address },
      last_payment_error: {
        code: 'card_declined',
        decline_code: 'insufficient_funds',
        type: 'card_error',
        message: `Card for ${PII.name} was declined`,
        payment_method: { id: 'pm_fixture_1', billing_details: billingDetails },
      },
    },
  };
}

export function stripeChargeRefundedData(ids: StripeFixtureIds & { paymentId: string }): Record<string, unknown> {
  return {
    object: {
      id: 'ch_fixture_1',
      object: 'charge',
      amount: 45000,
      amount_captured: 45000,
      amount_refunded: 10000,
      captured: true,
      created: 1_790_000_200,
      currency: 'usd',
      livemode: false,
      paid: true,
      refunded: false,
      status: 'succeeded',
      payment_intent: 'pi_fixture_1',
      payment_method: 'pm_fixture_1',
      metadata: { tenant_id: ids.tenantId, invoice_id: ids.invoiceId, payment_id: ids.paymentId },
      billing_details: billingDetails,
      receipt_email: PII.email,
      receipt_url: `https://pay.stripe.com/receipts/${PII.email}`,
      description: PII.description,
      shipping: { name: PII.name, address },
      payment_method_details: { type: 'card', card: { brand: 'visa', last4: '4242', exp_month: 1, exp_year: 2031 } },
      refunds: { object: 'list', data: [{ id: 're_fixture_1', amount: 10000, description: PII.description }] },
    },
    previous_attributes: { amount_refunded: 0, receipt_email: PII.email },
  };
}

export function stripeRefundUpdatedData(ids: StripeFixtureIds): Record<string, unknown> {
  return {
    object: {
      id: 're_fixture_1',
      object: 'refund',
      amount: 10000,
      charge: 'ch_fixture_1',
      created: 1_790_000_300,
      currency: 'usd',
      payment_intent: 'pi_fixture_1',
      reason: 'requested_by_customer',
      status: 'succeeded',
      metadata: { tenant_id: ids.tenantId },
      description: PII.description,
    },
  };
}

export function stripeDisputeCreatedData(ids: StripeFixtureIds): Record<string, unknown> {
  return {
    object: {
      id: 'dp_fixture_1',
      object: 'dispute',
      amount: 45000,
      charge: 'ch_fixture_1',
      created: 1_790_000_400,
      currency: 'usd',
      livemode: false,
      payment_intent: 'pi_fixture_1',
      reason: 'fraudulent',
      status: 'needs_response',
      is_charge_refundable: true,
      metadata: { tenant_id: ids.tenantId },
      evidence: {
        customer_name: PII.name,
        customer_email_address: PII.email,
        customer_purchase_ip: PII.ip,
        billing_address: PII.street,
        shipping_address: PII.street,
      },
      evidence_details: { due_by: 1_790_900_000, has_evidence: false },
    },
  };
}

export function stripeSetupIntentSucceededData(ids: { tenantId: string; customerId: string }): Record<string, unknown> {
  return {
    object: {
      id: 'seti_fixture_1',
      object: 'setup_intent',
      created: 1_790_000_500,
      livemode: false,
      status: 'succeeded',
      usage: 'off_session',
      customer: 'cus_fixture_1',
      payment_method: { id: 'pm_fixture_2', object: 'payment_method', billing_details: billingDetails },
      metadata: { tenant_id: ids.tenantId, customer_id: ids.customerId },
    },
  };
}

export function stripeInvoicePaymentFailedData(tenantId: string): Record<string, unknown> {
  return {
    object: {
      id: 'in_fixture_1',
      object: 'invoice',
      amount_due: 9900,
      amount_paid: 0,
      amount_remaining: 9900,
      attempt_count: 1,
      attempted: true,
      billing_reason: 'subscription_cycle',
      created: 1_790_000_600,
      currency: 'usd',
      customer: 'cus_platform_1',
      subscription: 'sub_fixture_1',
      status: 'open',
      total: 9900,
      metadata: { tenant_id: tenantId },
      customer_email: PII.email,
      customer_name: PII.name,
      customer_phone: PII.phone,
      customer_address: address,
      customer_shipping: { name: PII.name, address },
      account_name: PII.name,
      lines: { object: 'list', data: [{ id: 'il_1', description: PII.description }] },
    },
  };
}

export function stripeSubscriptionUpdatedData(tenantId: string): Record<string, unknown> {
  return {
    object: {
      id: 'sub_fixture_1',
      object: 'subscription',
      status: 'past_due',
      customer: 'cus_platform_1',
      created: 1_790_000_700,
      current_period_start: 1_790_000_000,
      current_period_end: 1_792_592_000,
      cancel_at_period_end: false,
      metadata: { tenant_id: tenantId, plan_id: 'plan_pro' },
      items: { object: 'list', data: [{ id: 'si_1', price: { id: 'price_1', nickname: PII.name } }] },
      default_payment_method: { id: 'pm_fixture_3', billing_details: billingDetails },
    },
    previous_attributes: { status: 'active' },
  };
}

export function stripeAccountUpdatedData(): Record<string, unknown> {
  return {
    object: {
      id: 'acct_fixture_1',
      object: 'account',
      type: 'standard',
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
      created: 1_790_000_800,
      email: PII.email,
      business_profile: { name: PII.name, support_email: PII.email, support_phone: PII.phone },
      individual: { first_name: PII.firstName, last_name: PII.lastName, email: PII.email, phone: PII.phone, address },
      external_accounts: { object: 'list', data: [{ id: 'ba_1', account_holder_name: PII.name, last4: '6789' }] },
      tos_acceptance: { ip: PII.ip, user_agent: PII.userAgent, date: 1_790_000_000 },
    },
  };
}

/** An event type the route does not handle: stored, then acknowledged. */
export function stripeCustomerUpdatedData(): Record<string, unknown> {
  return {
    object: {
      id: 'cus_fixture_1',
      object: 'customer',
      created: 1_790_000_900,
      livemode: false,
      email: PII.email,
      name: PII.name,
      phone: PII.phone,
      address,
      shipping: { name: PII.name, address },
    },
    previous_attributes: { email: 'old@example.com' },
  };
}

/** A Clerk svix envelope for a staff user (staff PII: names, emails, phones, IP). */
export function clerkUserEvent(type: string, userId: string): Record<string, unknown> {
  return {
    type,
    object: 'event',
    timestamp: 1_790_001_000_000,
    instance_id: 'ins_fixture_1',
    event_attributes: { http_request: { client_ip: PII.ip, user_agent: PII.userAgent } },
    data: {
      id: userId,
      object: 'user',
      first_name: PII.firstName,
      last_name: PII.lastName,
      username: PII.name,
      primary_email_address_id: 'idn_1',
      email_addresses: [{ id: 'idn_1', object: 'email_address', email_address: PII.email }],
      phone_numbers: [{ id: 'idn_2', object: 'phone_number', phone_number: PII.phone }],
      external_accounts: [{ provider: 'oauth_google', email_address: PII.email, first_name: PII.firstName }],
      image_url: `https://img.clerk.com/${PII.email}`,
      public_metadata: { tenant_id: '00000000-0000-4000-8000-000000000001', role: 'owner' },
      private_metadata: { note: PII.gateCode },
      unsafe_metadata: { signupAttribution: { referrer: PII.email } },
      created_at: 1_790_001_000_000,
      updated_at: 1_790_001_000_000,
    },
  };
}

/** Twilio inbound-SMS callback fields (form-encoded; every value a string). */
export function twilioInboundSmsBody(messageSid: string, accountSid: string): Record<string, string> {
  return {
    ToCountry: 'US',
    ToState: 'TX',
    SmsMessageSid: messageSid,
    NumMedia: '1',
    ToCity: 'AUSTIN',
    FromZip: PII.postalCode,
    SmsSid: messageSid,
    FromState: 'TX',
    SmsStatus: 'received',
    FromCity: PII.city,
    Body: PII.smsBody,
    FromCountry: 'US',
    To: PII.ownerPhone,
    MessagingServiceSid: 'MGfixture',
    ToZip: '78701',
    NumSegments: '1',
    MessageSid: messageSid,
    AccountSid: accountSid,
    From: PII.phone,
    MediaUrl0: PII.mediaUrl,
    MediaContentType0: 'image/jpeg',
    ApiVersion: '2010-04-01',
  };
}

/** Twilio voice webhook fields for an inbound call. */
export function twilioVoiceBody(callSid: string, accountSid: string): Record<string, string> {
  return {
    AccountSid: accountSid,
    ApiVersion: '2010-04-01',
    CallSid: callSid,
    CallStatus: 'ringing',
    Called: PII.ownerPhone,
    Caller: PII.phone,
    CallerName: PII.name,
    CallerCity: PII.city,
    CallerZip: PII.postalCode,
    Direction: 'inbound',
    From: PII.phone,
    FromCity: PII.city,
    FromZip: PII.postalCode,
    To: PII.ownerPhone,
    StirVerstat: 'TN-Validation-Passed-A',
  };
}

/** Twilio outbound-message status callback (the customer is `To`). */
export function twilioStatusBody(messageSid: string, accountSid: string): Record<string, string> {
  return {
    AccountSid: accountSid,
    ApiVersion: '2010-04-01',
    MessageSid: messageSid,
    SmsSid: messageSid,
    MessageStatus: 'undelivered',
    SmsStatus: 'undelivered',
    ErrorCode: '30006',
    From: PII.ownerPhone,
    To: PII.phone,
  };
}

/** A SendGrid Event Webhook batch (one delivery). */
export function sendGridEventBatch(sgEventId: string): Array<Record<string, unknown>> {
  return [
    {
      email: PII.email,
      timestamp: 1_790_002_000,
      'smtp-id': `<${PII.email}>`,
      event: 'bounce',
      category: ['estimate'],
      sg_event_id: sgEventId,
      sg_message_id: 'sgmsg_fixture_1.filter0001',
      reason: `550 5.1.1 <${PII.email}>: Recipient address rejected`,
      status: '5.1.1',
      type: 'bounce',
      ip: PII.ip,
      useragent: PII.userAgent,
      url: `https://example.com/estimate?to=${PII.email}`,
    },
  ];
}

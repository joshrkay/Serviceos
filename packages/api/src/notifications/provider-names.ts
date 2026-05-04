export const LEGACY_PROVIDER_BY_CANONICAL = {
  'sms-gateway': 'twilio-sms',
  'email-gateway': 'twilio-sendgrid',
} as const;

const CANONICAL_BY_PROVIDER: Record<string, 'sms-gateway' | 'email-gateway'> = {
  'sms-gateway': 'sms-gateway',
  'twilio-sms': 'sms-gateway',
  'email-gateway': 'email-gateway',
  'twilio-sendgrid': 'email-gateway',
};

export function normalizeDispatchProvider(provider: string): string {
  return CANONICAL_BY_PROVIDER[provider] ?? provider;
}

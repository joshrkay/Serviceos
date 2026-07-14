/**
 * Stripe Terminal SDK availability gate.
 *
 * The full `@stripe/stripe-terminal-react-native` stack requires a custom
 * native (EAS) build. Expo Go / web export cannot load it — callers must
 * fall back to SMS pay link or cash recording.
 */
export function isTerminalSdkAvailable(): boolean {
  // Native SDK is not wired in the managed Expo 52 app yet. Server-side
  // Terminal PaymentIntents are ready; enable this when an EAS build
  // installs @stripe/stripe-terminal-react-native and a device bridge.
  return false;
}

export type TerminalCollectResult =
  | { status: 'succeeded'; paymentIntentId: string }
  | { status: 'unavailable'; reason: string }
  | { status: 'failed'; message: string };

/**
 * Collect card-present payment for a prepared Terminal PaymentIntent.
 * Until the native SDK is linked, returns `unavailable` so the UI shows
 * fallbacks (pay link / cash) without crashing.
 */
export async function collectTerminalPayment(_input: {
  connectionTokenSecret: string;
  clientSecret: string;
  paymentIntentId: string;
  stripeAccountId: string;
}): Promise<TerminalCollectResult> {
  if (!isTerminalSdkAvailable()) {
    return {
      status: 'unavailable',
      reason:
        'In-person card collect requires a Terminal-enabled app build. Use the pay link or record cash for now.',
    };
  }
  return {
    status: 'failed',
    message: 'Terminal SDK bridge is not configured',
  };
}

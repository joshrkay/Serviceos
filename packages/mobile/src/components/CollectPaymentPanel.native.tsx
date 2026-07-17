import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useStripeTerminal } from '@stripe/stripe-terminal-react-native';
import { TerminalApiError, prepareTerminalCollect } from '../api/terminal';
import {
  isTerminalSdkAvailable,
  TERMINAL_UNAVAILABLE_REASON,
} from '../payments/terminalTypes';
import { formatMoneyCents } from '../lib/format';
import type { AuthedFetch } from '../api/me';

export interface CollectPaymentPanelProps {
  client: AuthedFetch;
  invoiceId: string;
  amountDueCents: number;
  payLinkUrl?: string | null;
  onCollected?: () => void;
}

const SIMULATED = process.env.EXPO_PUBLIC_TERMINAL_SIMULATED === '1';

function CollectPaymentFallback({
  amountDueCents,
  payLinkUrl,
  reason,
}: {
  amountDueCents: number;
  payLinkUrl?: string | null;
  reason: string;
}): JSX.Element {
  return (
    <View className="mt-4 space-y-3 rounded-2xl border border-border bg-card p-4" data-testid="collect-payment-panel">
      <Text className="text-base font-semibold text-foreground">Collect on site</Text>
      <Text className="text-sm text-muted-foreground">
        Charge {formatMoneyCents(amountDueCents)} with tap to pay or a reader.
      </Text>
      <Text className="text-sm text-muted-foreground" testID="collect-payment-message">
        {reason}
      </Text>
      {payLinkUrl ? (
        <Text className="text-sm text-muted-foreground" testID="collect-payment-fallback">
          Fallback: send the customer pay link ({payLinkUrl}).
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Native Terminal collect — Tap to Pay via Stripe Terminal SDK.
 * Requires an EAS build with the Terminal config plugin (not Expo Go).
 */
function NativeCollectBody({
  client,
  invoiceId,
  amountDueCents,
  payLinkUrl,
  onCollected,
}: CollectPaymentPanelProps): JSX.Element {
  const {
    initialize,
    easyConnect,
    retrievePaymentIntent,
    collectPaymentMethod,
    confirmPaymentIntent,
    connectedReader,
  } = useStripeTerminal();

  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [connectRequired, setConnectRequired] = useState(false);

  const startCollect = async () => {
    setBusy(true);
    setMessage(null);
    setConnectRequired(false);
    try {
      const initResult = await initialize();
      if (initResult?.error) {
        setMessage(initResult.error.message || 'Terminal SDK failed to initialize');
        return;
      }

      const prepared = await prepareTerminalCollect(client, invoiceId);

      if (!connectedReader) {
        const { error: connectError } = await easyConnect({
          discoveryMethod: 'tapToPay',
          locationId: prepared.connection.locationId,
          simulated: SIMULATED,
        });
        if (connectError) {
          setMessage(connectError.message || 'Could not connect Tap to Pay');
          return;
        }
      }

      const { paymentIntent, error: retrieveError } = await retrievePaymentIntent(
        prepared.payment.clientSecret,
      );
      if (retrieveError || !paymentIntent) {
        setMessage(retrieveError?.message || 'Could not load payment intent');
        return;
      }

      const { paymentIntent: collected, error: collectError } = await collectPaymentMethod({
        paymentIntent,
      });
      if (collectError || !collected) {
        setMessage(collectError?.message || 'Card collect was cancelled or failed');
        return;
      }

      const { paymentIntent: confirmed, error: confirmError } = await confirmPaymentIntent({
        paymentIntent: collected,
      });
      if (confirmError || !confirmed) {
        setMessage(confirmError?.message || 'Payment confirmation failed');
        return;
      }

      const status = String(confirmed.status ?? '');
      if (status !== 'succeeded' && status !== 'requires_capture') {
        setMessage(`Unexpected payment status: ${status || 'unknown'}`);
        return;
      }

      setMessage('Payment collected. Invoice will update when Stripe confirms.');
      onCollected?.();
    } catch (err) {
      if (err instanceof TerminalApiError && err.code === 'CONNECT_REQUIRED') {
        setConnectRequired(true);
        setMessage(err.message);
      } else if (
        err instanceof TerminalApiError &&
        err.code === 'TERMINAL_LOCATION_ADDRESS_REQUIRED'
      ) {
        setMessage(err.message);
      } else {
        setMessage(err instanceof Error ? err.message : 'Could not start card collect.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <View className="mt-4 space-y-3 rounded-2xl border border-border bg-card p-4" data-testid="collect-payment-panel">
      <Text className="text-base font-semibold text-foreground">Collect on site</Text>
      <Text className="text-sm text-muted-foreground">
        Charge {formatMoneyCents(amountDueCents)} with tap to pay or a reader.
      </Text>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Collect card payment"
        disabled={busy}
        onPress={() => void startCollect()}
        testID="collect-payment-button"
        className="min-h-11 items-center justify-center rounded-xl bg-primary px-4 disabled:opacity-50"
      >
        {busy ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text className="text-base font-semibold text-white">Collect payment</Text>
        )}
      </Pressable>

      {message ? (
        <Text
          className={`text-sm ${connectRequired ? 'text-amber-700' : 'text-muted-foreground'}`}
          testID="collect-payment-message"
        >
          {message}
        </Text>
      ) : null}

      {(connectRequired || message) && payLinkUrl ? (
        <Text className="text-sm text-muted-foreground" testID="collect-payment-fallback">
          Fallback: send the customer pay link ({payLinkUrl}).
        </Text>
      ) : null}
    </View>
  );
}

export function CollectPaymentPanel(props: CollectPaymentPanelProps): JSX.Element | null {
  if (props.amountDueCents <= 0) return null;
  if (!isTerminalSdkAvailable()) {
    return (
      <CollectPaymentFallback
        amountDueCents={props.amountDueCents}
        payLinkUrl={props.payLinkUrl}
        reason={TERMINAL_UNAVAILABLE_REASON}
      />
    );
  }
  return <NativeCollectBody {...props} />;
}

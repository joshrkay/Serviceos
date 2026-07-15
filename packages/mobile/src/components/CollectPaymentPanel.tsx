import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { TerminalApiError } from '../api/terminal';
import { useTerminalCollect } from '../payments/useTerminalCollect';
import { formatMoneyCents } from '../lib/format';
import type { AuthedFetch } from '../api/me';

export interface CollectPaymentPanelProps {
  client: AuthedFetch;
  invoiceId: string;
  amountDueCents: number;
  /** Optional public pay URL for CONNECT_REQUIRED / SDK unavailable fallback. */
  payLinkUrl?: string | null;
  onCollected?: () => void;
}

/**
 * Web / vitest Collect payment panel — Terminal native SDK is unavailable.
 * Still exposes the collect CTA so operators see fallbacks (pay link).
 */
export function CollectPaymentPanel({
  client,
  invoiceId,
  amountDueCents,
  payLinkUrl,
  onCollected,
}: CollectPaymentPanelProps): JSX.Element | null {
  const collect = useTerminalCollect();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [connectRequired, setConnectRequired] = useState(false);

  if (amountDueCents <= 0) return null;

  const startCollect = async () => {
    setBusy(true);
    setMessage(null);
    setConnectRequired(false);
    try {
      const result = await collect({ client, invoiceId });
      if (result.status === 'succeeded') {
        setMessage('Payment collected. Invoice will update when Stripe confirms.');
        onCollected?.();
        return;
      }
      if (result.status === 'unavailable') {
        setMessage(result.reason);
        return;
      }
      setMessage(result.message);
    } catch (err) {
      if (err instanceof TerminalApiError && err.code === 'CONNECT_REQUIRED') {
        setConnectRequired(true);
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

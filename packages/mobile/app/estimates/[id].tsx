import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { sendEstimate } from '../../src/api/estimates';
import { ErrorState } from '../../src/components/ErrorState';
import { LabelValueTable } from '../../src/components/LabelValueTable';
import { ScreenShell } from '../../src/components/ScreenShell';
import { useDetailQuery } from '../../src/hooks/useDetailQuery';
import { copyForError } from '../../src/lib/errorCopy';
import { formatMoneyCents, formatShortDate } from '../../src/lib/format';
import { useApiClient } from '../../src/lib/useApiClient';

interface EstimateDetail {
  id: string;
  estimateNumber?: string;
  status?: string;
  validUntil?: string;
  totals?: { totalCents?: number; subtotalCents?: number; taxCents?: number };
  customer?: {
    displayName?: string;
    firstName?: string;
    lastName?: string;
    email?: string;
  };
}

function customerName(est?: EstimateDetail): string | undefined {
  const c = est?.customer;
  if (!c) return undefined;
  return c.displayName || [c.firstName, c.lastName].filter(Boolean).join(' ');
}

export default function EstimateDetailScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = Array.isArray(params.id) ? params.id[0] : (params.id ?? '');
  const client = useApiClient();
  const { data, isLoading, error, refetch } = useDetailQuery<EstimateDetail>(
    id ? `/api/estimates/${id}` : null,
  );

  // A7 — estimate nudge. Only a SENT estimate that the customer hasn't yet
  // accepted/rejected/expired can be nudged; those terminal states get no
  // forward action. The nudge is a comms-lane action, so it sits behind the
  // same explicit confirm as the invoice Send (U1/U5 pattern).
  const [nudging, setNudging] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const title = data?.estimateNumber ?? (id ? `Estimate ${id.slice(0, 8)}` : 'Estimate');
  const canNudge = data?.status === 'sent';

  async function sendReminder() {
    if (!data || nudging) return; // double-tap guard
    setNudging(true);
    setActionError(null);
    try {
      // Direct route: POST /api/estimates/:id/send re-sends the estimate link to
      // the customer (SendService records the FIRST send once, so re-sends are a
      // supported nudge — see notifications/send-service.ts). This is the
      // owner-initiated nudge; the AI `send_estimate_nudge` proposal (with
      // reminderCount bookkeeping + nudge copy) remains a voice-originated path
      // with no client-mint route, so it is not wired here.
      await sendEstimate(client, data.id);
      setConfirming(false);
      await refetch(); // no optimistic state — re-read the server
    } catch (err) {
      setActionError(copyForError(err).body);
    } finally {
      setNudging(false);
    }
  }

  return (
    <ScreenShell title={title} backLabel="‹ Estimates">
      {isLoading ? <ActivityIndicator /> : null}
      {error ? <ErrorState error={error} showRetry onRetry={() => void refetch()} className="mb-4" /> : null}

      {data ? (
        <>
          <Text className="mb-4 text-2xl font-semibold text-foreground">
            {formatMoneyCents(data.totals?.totalCents ?? 0)}
          </Text>
          <LabelValueTable
            rows={[
              { label: 'Status', value: data.status },
              { label: 'Valid until', value: data.validUntil ? formatShortDate(data.validUntil) : undefined },
              { label: 'Customer', value: customerName(data) },
              { label: 'Email', value: data.customer?.email },
              { label: 'Subtotal', value: formatMoneyCents(data.totals?.subtotalCents ?? 0) },
              { label: 'Tax', value: formatMoneyCents(data.totals?.taxCents ?? 0) },
            ]}
          />

          {/* Nudge affordance — only for sent-but-unaccepted estimates. */}
          {canNudge ? (
            <View className="mt-5 gap-3">
              {actionError ? (
                <Text className="text-base text-destructive">{actionError}</Text>
              ) : null}

              {confirming ? (
                <View className="rounded-lg border border-border bg-card p-4">
                  <Text className="text-base font-medium text-foreground">
                    Nudge {customerName(data) ?? 'the customer'} — this messages them.
                  </Text>
                  <Text className="mt-2 text-base text-mutedForeground">
                    We re-send the estimate link so they can review and approve it.
                  </Text>
                  <View className="mt-3 flex-row gap-3">
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Cancel"
                      onPress={() => setConfirming(false)}
                      disabled={nudging}
                      className="min-h-11 flex-1 items-center justify-center rounded-md border border-border px-4 py-3"
                    >
                      <Text className="text-base text-foreground">Cancel</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Send reminder"
                      onPress={() => void sendReminder()}
                      disabled={nudging}
                      className="min-h-11 flex-1 items-center justify-center rounded-md bg-primary px-4 py-3"
                    >
                      {nudging ? (
                        <ActivityIndicator color="#ffffff" />
                      ) : (
                        <Text className="text-base font-semibold text-primaryForeground">
                          Send reminder
                        </Text>
                      )}
                    </Pressable>
                  </View>
                </View>
              ) : (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Nudge customer"
                  onPress={() => {
                    setActionError(null);
                    setConfirming(true);
                  }}
                  className="min-h-11 items-center justify-center rounded-md border border-border px-4 py-3"
                >
                  <Text className="text-base font-semibold text-foreground">Nudge customer</Text>
                </Pressable>
              )}
            </View>
          ) : null}
        </>
      ) : null}
    </ScreenShell>
  );
}

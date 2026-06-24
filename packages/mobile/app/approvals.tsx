import { useState } from 'react';
import { useRouter } from 'expo-router';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { usePendingProposals } from '../src/hooks/usePendingProposals';
import { useApproveBatch } from '../src/proposals/useApproveBatch';
import { typeLabel } from '../src/proposals/proposalReview';
import {
  type ConfidenceBand,
  confidenceBand,
  hoursUntilExpiry,
  isBatchEligible,
} from '../src/proposals/proposalEvents';
import { ErrorState } from '../src/components/ErrorState';
import { useToast } from '../src/components/Toast';

const BAND_LABEL: Record<ConfidenceBand, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

// Confidence steers the eye: high reads calm (success), low reads "look at me"
// (destructive) — the opposite of urgency, so the operator triages by trust.
const BAND_TONE: Record<ConfidenceBand, string> = {
  high: 'text-success',
  medium: 'text-warning',
  low: 'text-destructive',
};

// Approvals inbox: the AI's pending drafts (from voice capture etc.), polled
// live. Each card shows its confidence and time-to-expiry; tapping opens the
// review screen (approve with a 5s undo). High-confidence capture-class
// proposals can be approved in one tap via "Approve all" — money, customer
// sends, and anything needing review are excluded and stay individual.
export default function Approvals() {
  const router = useRouter();
  const { proposals, count, isLoading, error, refresh } = usePendingProposals();
  const approveBatch = useApproveBatch();
  const { showToast, showErrorToast } = useToast();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const eligible = proposals.filter(isBatchEligible);

  async function onConfirmApproveAll(): Promise<void> {
    setSubmitting(true);
    try {
      const result = await approveBatch(eligible.map((p) => p.id));
      const approved = result.approved.length;
      const failed = result.failed.length;
      // When the whole batch fails, "Approved 0" would read as success — flip
      // the title and tone (ToastTone is only 'info' | 'error').
      showToast({
        title: approved > 0 ? `Approved ${approved}` : 'No proposals approved',
        body: failed > 0 ? `${failed} couldn't be approved — review individually.` : undefined,
        tone: approved > 0 ? 'info' : 'error',
      });
      setSheetOpen(false);
      await refresh();
    } catch (err) {
      showErrorToast(err); // keep the sheet open so the operator can retry
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View className="flex-1 bg-background pt-16">
      <View className="px-6">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={() => router.back()}
          className="min-h-11 justify-center"
        >
          <Text className="text-base text-mutedForeground">‹ Back</Text>
        </Pressable>
        <Text className="mt-2 text-2xl font-semibold text-foreground">Approvals</Text>
        <Text className="mt-1 text-base text-mutedForeground">
          {count === 0 ? 'Nothing waiting' : `${count} waiting for you`}
        </Text>
        {error ? <ErrorState error={error} showRetry={false} className="mt-3" /> : null}

        {eligible.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Approve all eligible"
            onPress={() => setSheetOpen(true)}
            className="mt-3 min-h-11 flex-row items-center justify-between rounded-lg border border-border bg-card px-4 py-2"
          >
            <Text className="flex-1 pr-3 text-sm text-foreground">
              {eligible.length} high-confidence eligible for one-tap approval
            </Text>
            <Text className="text-sm font-semibold text-primary">Approve all</Text>
          </Pressable>
        ) : null}
      </View>

      <FlatList
        data={proposals}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ padding: 24 }}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={() => void refresh()} />}
        ListEmptyComponent={
          isLoading ? (
            <ActivityIndicator />
          ) : (
            <Text className="text-base text-mutedForeground">
              Speak an action and your drafts will appear here for approval.
            </Text>
          )
        }
        renderItem={({ item }) => {
          const band = confidenceBand(item.confidenceScore);
          const hrs = hoursUntilExpiry(item.expiresAt);
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Review ${typeLabel(item.proposalType)}: ${item.summary}`}
              onPress={() => router.push(`/proposals/${item.id}`)}
              className="mb-3 min-h-11 rounded-lg border border-border bg-card p-4"
            >
              <View className="flex-row items-center justify-between">
                <Text className="text-sm text-mutedForeground">{typeLabel(item.proposalType)}</Text>
                <View className="flex-row items-center">
                  {band ? (
                    <Text
                      className={`rounded-full bg-secondary px-2 py-0.5 text-xs font-medium ${BAND_TONE[band]}`}
                    >
                      {BAND_LABEL[band]}
                    </Text>
                  ) : null}
                  {hrs !== null ? (
                    <Text className="ml-2 text-xs text-mutedForeground">{hrs}h</Text>
                  ) : null}
                </View>
              </View>
              <Text className="mt-1 text-base text-foreground">{item.summary}</Text>
            </Pressable>
          );
        }}
      />

      {sheetOpen ? (
        <View className="absolute bottom-0 left-0 right-0 top-0">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel approve all"
            onPress={() => setSheetOpen(false)}
            className="absolute bottom-0 left-0 right-0 top-0 bg-black/50"
          />
          <View className="absolute bottom-0 left-0 right-0 rounded-t-xl bg-card px-6 pb-8 pt-4">
            <Text className="text-base font-semibold text-foreground">
              Approve {eligible.length} high-confidence?
            </Text>
            <Text className="mt-1 text-sm text-mutedForeground">
              Money, customer messages, and anything needing review are excluded — approve those
              individually.
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Confirm approve all"
              disabled={submitting}
              onPress={() => void onConfirmApproveAll()}
              className="mt-4 min-h-11 items-center justify-center rounded-md bg-primary px-4 py-3"
            >
              {submitting ? (
                <ActivityIndicator color="#ffffff" />
              ) : (
                <Text className="text-base font-semibold text-primaryForeground">
                  Approve {eligible.length} eligible
                </Text>
              )}
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Dismiss"
              onPress={() => setSheetOpen(false)}
              className="mt-2 min-h-11 items-center justify-center"
            >
              <Text className="text-base text-mutedForeground">Cancel</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

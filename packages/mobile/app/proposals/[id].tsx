import { useLocalSearchParams, useRouter } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { useProposalReview } from '../../src/hooks/useProposalReview';
import { reviewRows, typeLabel } from '../../src/proposals/proposalReview';

// Proposal review + 5-second undo. The owner taps a proposal in the inbox,
// reviews the AI's draft, and approves it — then has a 5s window to undo before
// the action executes server-side. Nothing auto-executes ahead of approval.
export default function ProposalReviewScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = Array.isArray(params.id) ? params.id[0] : (params.id ?? '');
  const router = useRouter();
  const { proposal, phase, error, secondsLeft, approve, undo, reload } = useProposalReview(id);

  return (
    <View className="flex-1 bg-background pt-16">
      <View className="px-6">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={() => router.back()}
          className="min-h-11 justify-center"
        >
          <Text className="text-base text-mutedForeground">‹ Approvals</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={{ padding: 24 }}>
        {phase === 'loading' ? <ActivityIndicator /> : null}

        {phase === 'error' ? (
          <View>
            <Text className="text-base text-destructive">{error}</Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => void reload()}
              className="mt-4 min-h-11 items-center justify-center rounded-md border border-border px-4 py-3"
            >
              <Text className="text-base text-foreground">Try again</Text>
            </Pressable>
          </View>
        ) : null}

        {proposal && phase !== 'loading' && phase !== 'error' ? (
          <View>
            <Text className="text-sm text-mutedForeground">{typeLabel(proposal.proposalType)}</Text>
            <Text className="mt-1 text-2xl font-semibold text-foreground">{proposal.summary}</Text>

            {proposal.explanation ? (
              <Text className="mt-3 text-base text-mutedForeground">{proposal.explanation}</Text>
            ) : null}

            {reviewRows(proposal.payload).length > 0 ? (
              <View className="mt-5 rounded-lg border border-border">
                {reviewRows(proposal.payload).map((row) => (
                  <View
                    key={row.label}
                    className="flex-row justify-between border-b border-border px-4 py-3"
                  >
                    <Text className="text-base text-mutedForeground">{row.label}</Text>
                    <Text className="text-base text-foreground">{row.value}</Text>
                  </View>
                ))}
              </View>
            ) : null}

            {/* Review → Approve */}
            {phase === 'review' || phase === 'approving' ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Approve"
                onPress={() => void approve()}
                disabled={phase === 'approving'}
                className="mt-8 min-h-11 items-center justify-center rounded-md bg-primary px-4 py-3"
              >
                {phase === 'approving' ? (
                  <ActivityIndicator color="#ffffff" />
                ) : (
                  <Text className="text-base font-semibold text-primaryForeground">Approve</Text>
                )}
              </Pressable>
            ) : null}

            {/* Approved → 5s undo window */}
            {phase === 'approved' || phase === 'undoing' ? (
              <View className="mt-8">
                <Text className="text-base text-foreground">✓ Approved</Text>
                <Text className="mt-1 text-base text-mutedForeground">
                  Running in {secondsLeft}s — tap undo to stop.
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Undo"
                  onPress={() => void undo()}
                  disabled={phase === 'undoing'}
                  className="mt-3 min-h-11 items-center justify-center rounded-md bg-destructive px-4 py-3"
                >
                  {phase === 'undoing' ? (
                    <ActivityIndicator color="#ffffff" />
                  ) : (
                    <Text className="text-base font-semibold text-destructiveForeground">
                      Undo ({secondsLeft})
                    </Text>
                  )}
                </Pressable>
              </View>
            ) : null}

            {/* Committed (window elapsed) */}
            {phase === 'committed' ? (
              <View className="mt-8">
                <Text className="text-base text-foreground">✓ Approved</Text>
                <Text className="mt-1 text-base text-mutedForeground">
                  We&apos;ll run it and let you know when it&apos;s done.
                </Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => router.back()}
                  className="mt-4 min-h-11 items-center justify-center rounded-md border border-border px-4 py-3"
                >
                  <Text className="text-base text-foreground">Back to approvals</Text>
                </Pressable>
              </View>
            ) : null}

            {/* Undone */}
            {phase === 'undone' ? (
              <View className="mt-8">
                <Text className="text-base text-foreground">✓ Undone</Text>
                <Text className="mt-1 text-base text-mutedForeground">
                  Nothing was executed. You can speak a new action anytime.
                </Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => router.back()}
                  className="mt-4 min-h-11 items-center justify-center rounded-md border border-border px-4 py-3"
                >
                  <Text className="text-base text-foreground">Back to approvals</Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { ClarifyPicker } from '../../src/components/ClarifyPicker';
import { ErrorState } from '../../src/components/ErrorState';
import { useProposalReview } from '../../src/hooks/useProposalReview';
import { formatMoneyCents } from '../../src/lib/format';
import {
  ambiguousCatalogLines,
  entityCandidatesFromPayload,
  reviewRows,
  typeLabel,
} from '../../src/proposals/proposalReview';

// Proposal review + 5-second undo. The owner taps a proposal in the inbox,
// reviews the AI's draft, and approves it — then has a 5s window to undo before
// the action executes server-side. Nothing auto-executes ahead of approval.
export default function ProposalReviewScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = Array.isArray(params.id) ? params.id[0] : (params.id ?? '');
  const router = useRouter();
  const { proposal, phase, error, secondsLeft, approve, reject, resolveLine, undo, reload } =
    useProposalReview(id);
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

  const entityCandidates =
    proposal?.proposalType === 'voice_clarification'
      ? entityCandidatesFromPayload(proposal.payload)
      : [];
  const catalogAmbiguities = ambiguousCatalogLines(proposal?.payload, proposal?.sourceContext);

  async function confirmReject() {
    const reason = rejectReason.trim();
    if (!reason) return;
    await reject(reason);
    setShowRejectForm(false);
    setRejectReason('');
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
          <Text className="text-base text-mutedForeground">‹ Approvals</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={{ padding: 24 }}>
        {phase === 'loading' ? <ActivityIndicator /> : null}

        {phase === 'error' ? (
          <ErrorState error={error} showRetry onRetry={() => void reload()} />
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

            {entityCandidates.length > 0 && phase === 'review' ? (
              <View className="mt-5">
                <ClarifyPicker
                  title="Which one did you mean?"
                  options={entityCandidates.map((c) => ({
                    id: c.id,
                    label: c.label,
                    description: c.hint,
                  }))}
                  onSelect={(option) => {
                    void reject('entity_selected', option.id);
                  }}
                />
              </View>
            ) : null}

            {catalogAmbiguities.length > 0 && phase === 'review'
              ? catalogAmbiguities.map((line) => (
                  <View key={line.lineIndex} className="mt-5">
                    <ClarifyPicker
                      title={`Which item for "${line.description}"?`}
                      options={line.candidates.map((c) => ({
                        id: c.id,
                        label: c.name,
                        description: formatMoneyCents(c.unitPriceCents),
                      }))}
                      onSelect={(option) => {
                        void resolveLine(line.lineIndex, option.id);
                      }}
                    />
                  </View>
                ))
              : null}

            {/* Review → Approve / Reject */}
            {phase === 'review' || phase === 'approving' || phase === 'rejecting' ? (
              <View className="mt-8 gap-3">
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Approve"
                  onPress={() => void approve()}
                  disabled={phase === 'approving' || phase === 'rejecting'}
                  className="min-h-11 items-center justify-center rounded-md bg-primary px-4 py-3"
                >
                  {phase === 'approving' ? (
                    <ActivityIndicator color="#ffffff" />
                  ) : (
                    <Text className="text-base font-semibold text-primaryForeground">Approve</Text>
                  )}
                </Pressable>

                {!showRejectForm ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Reject"
                    onPress={() => setShowRejectForm(true)}
                    disabled={phase === 'approving' || phase === 'rejecting'}
                    className="min-h-11 items-center justify-center rounded-md border border-border px-4 py-3"
                  >
                    <Text className="text-base font-semibold text-foreground">Reject</Text>
                  </Pressable>
                ) : (
                  <View className="rounded-lg border border-border bg-card p-4">
                    <Text className="text-base font-medium text-foreground">Why reject?</Text>
                    <TextInput
                      accessibilityLabel="Rejection reason"
                      value={rejectReason}
                      onChangeText={setRejectReason}
                      placeholder="Tell the AI what was wrong"
                      placeholderTextColor="#94a3b8"
                      className="mt-3 min-h-11 rounded-md border border-border px-4 py-3 text-base text-foreground"
                    />
                    <View className="mt-3 flex-row gap-3">
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Cancel reject"
                        onPress={() => {
                          setShowRejectForm(false);
                          setRejectReason('');
                        }}
                        className="min-h-11 flex-1 items-center justify-center rounded-md border border-border px-4 py-3"
                      >
                        <Text className="text-base text-foreground">Cancel</Text>
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Confirm reject"
                        onPress={() => void confirmReject()}
                        disabled={!rejectReason.trim() || phase === 'rejecting'}
                        className="min-h-11 flex-1 items-center justify-center rounded-md bg-destructive px-4 py-3"
                      >
                        {phase === 'rejecting' ? (
                          <ActivityIndicator color="#ffffff" />
                        ) : (
                          <Text className="text-base font-semibold text-destructiveForeground">
                            Reject
                          </Text>
                        )}
                      </Pressable>
                    </View>
                  </View>
                )}
              </View>
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

            {/* Undone / rejected */}
            {phase === 'undone' ? (
              <View className="mt-8">
                <Text className="text-base text-foreground">
                  {proposal.status === 'rejected' ? '✓ Rejected' : '✓ Undone'}
                </Text>
                <Text className="mt-1 text-base text-mutedForeground">
                  {proposal.status === 'rejected'
                    ? 'Nothing was executed. Your feedback helps the AI improve.'
                    : 'Nothing was executed. You can speak a new action anytime.'}
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

import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useAuth } from '@clerk/clerk-expo';
import { useRouter } from 'expo-router';
import { PrimaryButton } from '../../src/components/Buttons';
import { skipSetupGateForSession } from '../../src/hooks/useOnboardingStatus';
import { usePendingProposals } from '../../src/hooks/usePendingProposals';
import { useOnboardingTalkController } from '../../src/onboarding/useOnboardingTalkController';
import {
  heldForReviewCopy,
  MIC_DENIED_COPY,
  MIC_FAILED_COPY,
  type TalkError,
} from '../../src/onboarding/useOnboardingTalk';
import { isBatchEligible } from '../../src/proposals/proposalEvents';
import { useRecorder } from '../../src/voice/useRecorder';

const ERROR_ACTION_LABEL: Record<TalkError['action'], string | null> = {
  retry_turn: 'Try again',
  restart: 'Start again',
  retry_save: 'Try again',
  check_again: 'Check again',
  none: null,
};

/**
 * Spoken setup. The owner holds the mic (or types) and Rivet walks through the
 * business, services, prices, team and hours, speaking each reply. When the
 * conversation is done the setup items are listed and "Save my setup"
 * approves them; once the business-identity step has executed, the app opens.
 * Lives in the (onboarding) group so the setup gate lets the owner stay here.
 */
export default function SetupVoiceScreen() {
  const router = useRouter();
  const { userId } = useAuth();
  const talk = useOnboardingTalkController();
  const recorder = useRecorder();
  const [draft, setDraft] = useState('');
  const [holding, setHolding] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const { status, turns, proposalIds, error, sttUnavailable } = talk;
  const inReview = status === 'review' || status === 'saving';
  const pending = usePendingProposals({ enabled: inReview });
  const items = pending.proposals.filter((p) => proposalIds.includes(p.id));
  // Only high-confidence capture items are saved in one tap; anything else (or not yet
  // loaded) is held for individual review, the same rule as the Approvals batch.
  const eligibleIds = items.filter(isBatchEligible).map((p) => p.id);
  const heldCount = proposalIds.length - eligibleIds.length;

  const { refresh } = pending;
  useEffect(() => {
    if (inReview) void refresh();
  }, [inReview, refresh]);

  const busy = status === 'starting' || status === 'sending';
  const talking = status === 'ready' || status === 'sending';

  const onPressIn = async () => {
    setHolding(true);
    setMicError(null);
    talk.hush();
    const outcome = await recorder.startRecording();
    if (outcome === 'recording') return;
    setHolding(false);
    if (outcome === 'denied') setMicError(MIC_DENIED_COPY);
    else if (outcome === 'error') setMicError(MIC_FAILED_COPY);
  };
  const onPressOut = async () => {
    setHolding(false);
    const uri = await recorder.stopRecording();
    if (uri) void talk.sendAudio(uri);
  };
  const submitDraft = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    void talk.sendText(text);
  };
  const reviewInApprovals = () => {
    // Approvals sits outside the setup group; the session pass lets the owner reach it.
    skipSetupGateForSession(userId);
    router.push('/approvals');
  };
  const skip = () => {
    skipSetupGateForSession(userId);
    router.replace('/');
  };
  const openApp = () => {
    // The business-identity step was just confirmed done by this screen's own status read. The
    // gate's copy of the status can still be the earlier "not done" for a moment, which would
    // bounce the owner back to the welcome screen; the session pass covers that window only.
    skipSetupGateForSession(userId);
    router.replace('/');
  };

  const actionLabel = error ? ERROR_ACTION_LABEL[error.action] : null;

  return (
    <View className="flex-1 bg-background px-6 pb-6 pt-24">
      <Text className="font-heading text-2xl font-semibold text-foreground">Set up by voice</Text>
      <Text className="mt-1 text-base text-mutedForeground">
        Tell me about your business. I&apos;ll ask about your services, prices, team and hours, then you check it
        before anything is saved.
      </Text>

      <ScrollView className="mt-4 flex-1" contentContainerClassName="pb-4">
        {turns.map((turn) => (
          <View
            key={turn.id}
            className={`mb-3 max-w-full rounded-lg px-4 py-3 ${
              turn.role === 'owner' ? 'self-end bg-primary' : 'self-start border border-border bg-card'
            }`}
          >
            <Text className={`text-base ${turn.role === 'owner' ? 'text-primaryForeground' : 'text-foreground'}`}>
              {turn.text}
            </Text>
          </View>
        ))}
        {busy ? (
          <View className="mb-3 self-start">
            <ActivityIndicator />
          </View>
        ) : null}

        {inReview ? (
          <View className="mt-2 rounded-lg border border-border bg-card px-4 py-3">
            <Text className="text-base font-semibold text-foreground">Here&apos;s what I&apos;ll set up</Text>
            {items.length > 0 ? (
              items.map((p) => (
                <Text key={p.id} className="mt-2 text-base text-foreground">
                  {p.summary}
                  {isBatchEligible(p) ? '' : ' (needs a closer look)'}
                </Text>
              ))
            ) : (
              <Text className="mt-2 text-base text-mutedForeground">
                {proposalIds.length === 1 ? '1 setup item' : `${proposalIds.length} setup items`}
              </Text>
            )}
          </View>
        ) : null}
      </ScrollView>

      {micError ? <Text className="mb-3 text-base text-destructive">{micError}</Text> : null}

      {error ? (
        <View className="mb-3">
          <Text className="text-base text-destructive">{error.message}</Text>
          {actionLabel ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => void talk.recover()}
              className="mt-2 min-h-11 items-center justify-center rounded-md border border-border px-4 py-3"
            >
              <Text className="text-base text-foreground">{actionLabel}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {status === 'finished' ? (
        <View>
          <Text className="mb-2 text-base text-foreground">You&apos;re set up.</Text>
          <PrimaryButton label="Open my business" onPress={openApp} />
        </View>
      ) : inReview ? (
        <View>
          {heldCount > 0 && !pending.isLoading ? (
            <View className="mb-3">
              <Text className="text-base text-foreground">{heldForReviewCopy(heldCount)}</Text>
              <Pressable
                accessibilityRole="button"
                onPress={reviewInApprovals}
                className="mt-2 min-h-11 items-center justify-center rounded-md border border-border px-4 py-3"
              >
                <Text className="text-base text-foreground">Check in Approvals</Text>
              </Pressable>
            </View>
          ) : null}
          <PrimaryButton
            label="Save my setup"
            loading={status === 'saving' && !error}
            disabled={eligibleIds.length === 0 || status === 'saving'}
            onPress={() => void talk.save(eligibleIds)}
          />
        </View>
      ) : talking ? (
        <View>
          <View className="flex-row items-end">
            <TextInput
              className="mr-2 min-h-11 flex-1 rounded-md border border-border bg-card px-3 py-2 text-base text-foreground"
              placeholder="Or type your answer"
              value={draft}
              onChangeText={setDraft}
              editable={!busy}
              onSubmitEditing={submitDraft}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send answer"
              onPress={submitDraft}
              disabled={busy || !draft.trim()}
              className="min-h-11 items-center justify-center rounded-md bg-primary px-4 py-2"
            >
              <Text className="text-base font-semibold text-primaryForeground">Send</Text>
            </Pressable>
          </View>
          {!sttUnavailable ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Hold to talk"
              onPressIn={() => void onPressIn()}
              onPressOut={() => void onPressOut()}
              disabled={busy}
              className={`mt-3 min-h-14 items-center justify-center rounded-md px-4 py-3 ${
                holding ? 'bg-destructive' : 'bg-primary'
              }`}
            >
              <Text className="text-base font-semibold text-primaryForeground">
                {holding ? 'Listening… release to send' : 'Hold to talk'}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {status !== 'finished' ? (
        <Pressable
          accessibilityRole="button"
          onPress={skip}
          className="mt-3 min-h-11 items-center justify-center rounded-md px-4 py-3"
        >
          <Text className="text-base text-mutedForeground">Skip for now</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

import { ActivityIndicator, Pressable, Switch, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { AnswerCard } from '../../src/components/AnswerCard';
import { useMe } from '../../src/hooks/useMe';
import { navModelFor } from '../../src/navigation/personaNav';
import { useSpeakAnswers } from '../../src/voice/useSpeakAnswers';
import { useVoiceCapture } from '../../src/voice/useVoiceCapture';

// Hold-to-talk capture screen. The operator presses the mic, speaks one
// action, releases; the clip uploads + transcribes and the AI either drafts
// proposals (surfaced in approvals) or — for read-only asks (U3 E-lane) —
// answers inline with an AnswerCard, spoken back since #1603. Dirty-hands UX:
// one large target. Technicians have this tab too (#1603): their drafts go to
// a permission holder, so the approval copy names the office, never "you".
export default function VoiceScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ jobId?: string | string[] }>();
  const jobId = Array.isArray(params.jobId) ? params.jobId[0] : params.jobId;
  const { phase, transcript, outcome, error, startRecording, stopAndTranscribe, reset } =
    useVoiceCapture(jobId);
  // #1603 — a lookup answer is also spoken (server TTS), per-device toggle.
  const speak = useSpeakAnswers(outcome);
  const { me } = useMe();
  const technician = me
    ? navModelFor({
        role: me.role,
        currentMode: me.current_mode,
        canFieldServe: me.can_field_serve,
      }).persona === 'tech'
    : false;
  const listening = phase === 'listening';
  const busy = phase === 'transcribing';

  return (
    <View className="flex-1 bg-background px-6 pb-20 pt-24">
      <Text className="font-heading text-2xl font-semibold text-foreground">
        {jobId ? 'Update this job' : 'Speak an action'}
      </Text>
      <Text className="mt-1 text-base text-mutedForeground">
        {jobId
          ? technician
            ? "Describe what happened on this job. We'll send an update to your office for approval."
            : "Describe what happened on this job. We'll draft an update for approval."
          : technician
            ? "Hold the mic, say what happened, release. We'll send it to your office for approval."
            : "Hold the mic, say what happened, release. We'll draft it for your approval."}
      </Text>

      {/* #1603 — hands-free: answers to questions are read aloud. Per-device,
          default on; the text answer always stays on screen regardless. The
          label is its own ≥44px target (gloved tap) — the RN Switch alone is
          ~31px tall. */}
      <View className="mt-3 flex-row items-center justify-between">
        <Pressable
          accessibilityRole="switch"
          accessibilityState={{ checked: speak.enabled ?? true }}
          disabled={speak.enabled === null}
          onPress={() => speak.setEnabled(!(speak.enabled ?? true))}
          className="min-h-11 flex-1 justify-center"
        >
          <Text className="text-base text-foreground">Speak answers aloud</Text>
        </Pressable>
        <Switch
          accessibilityLabel="Speak answers aloud"
          value={speak.enabled ?? true}
          disabled={speak.enabled === null}
          onValueChange={speak.setEnabled}
        />
      </View>

      <View className="flex-1 items-center justify-center">
        {phase === 'queued' ? (
          <View className="w-full items-center">
            <Text className="text-lg font-semibold text-foreground">Saved offline</Text>
            <Text className="mt-2 text-center text-base text-mutedForeground">
              You're offline — we saved this and will send it for approval when you
              reconnect.
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={reset}
              className="mt-6 min-h-11 items-center justify-center rounded-md border border-border px-4 py-3"
            >
              <Text className="text-base text-foreground">Speak again</Text>
            </Pressable>
          </View>
        ) : phase === 'transcript' ? (
          <View className="w-full">
            <Text className="mb-2 text-base text-mutedForeground">Heard</Text>
            <Text className="text-lg text-foreground">{transcript}</Text>
            {outcome?.kind === 'answered' ? (
              // U3 — E-lane answer: render it inline; no approvals round-trip.
              <View className="mt-4 w-full">
                <AnswerCard answer={outcome.answer} />
              </View>
            ) : outcome?.kind === 'failed' ? (
              // U3 — lookup execution failed server-side: retry affordance.
              <Text className="mt-4 text-base text-destructive">
                Couldn't get that answer. Try asking again.
              </Text>
            ) : technician ? (
              // proposal / clarification / skipped / timeout for a technician:
              // the draft goes to a permission holder (no proposals:approve
              // on this role), so no approvals round-trip is offered.
              <Text className="mt-4 text-base text-mutedForeground">
                Drafting — sent to your office for approval.
              </Text>
            ) : (
              // proposal / clarification / skipped / timeout — today's flow.
              <>
                <Text className="mt-4 text-base text-mutedForeground">
                  Drafting — your proposals will appear in approvals.
                </Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    reset();
                    router.push('/approvals');
                  }}
                  className="mt-6 min-h-11 items-center justify-center rounded-md bg-primary px-4 py-3"
                >
                  <Text className="text-base font-semibold text-primaryForeground">
                    View approvals
                  </Text>
                </Pressable>
              </>
            )}
            <Pressable
              accessibilityRole="button"
              onPress={reset}
              className="mt-3 min-h-11 items-center justify-center rounded-md border border-border px-4 py-3"
            >
              <Text className="text-base text-foreground">
                {outcome?.kind === 'failed' ? 'Try again' : 'Speak again'}
              </Text>
            </Pressable>
          </View>
        ) : (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Hold to record"
              onPressIn={() => {
                void startRecording();
              }}
              onPressOut={() => {
                void stopAndTranscribe();
              }}
              disabled={busy}
              className={`h-44 w-44 items-center justify-center rounded-full ${
                listening ? 'bg-destructive' : 'bg-primary'
              }`}
            >
              {busy ? (
                <ActivityIndicator color="#ffffff" />
              ) : (
                <Text className="text-lg font-semibold text-primaryForeground">
                  {listening ? 'Listening…' : 'Hold'}
                </Text>
              )}
            </Pressable>
            <Text className="mt-4 text-base text-mutedForeground">
              {busy ? 'Uploading & transcribing…' : 'Hold to speak · release to send'}
            </Text>
          </>
        )}

        {error ? (
          <View className="mt-8 w-full">
            <Text className="text-base text-destructive">{error}</Text>
            <Pressable
              accessibilityRole="button"
              onPress={reset}
              className="mt-3 min-h-11 items-center justify-center rounded-md border border-border px-4 py-3"
            >
              <Text className="text-base text-foreground">Try again</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    </View>
  );
}

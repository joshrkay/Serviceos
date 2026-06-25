import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useVoiceCapture } from '../../src/voice/useVoiceCapture';

// Hold-to-talk capture screen. Owner presses the mic, speaks one action,
// releases; the clip uploads + transcribes and the AI drafts proposals
// (surfaced in approvals — a later unit). Dirty-hands UX: one large target.
export default function VoiceScreen() {
  const router = useRouter();
  const { phase, transcript, error, startRecording, stopAndTranscribe, reset } = useVoiceCapture();
  const listening = phase === 'listening';
  const busy = phase === 'transcribing';

  return (
    <View className="flex-1 bg-background px-6 pb-20 pt-24">
      <Text className="font-heading text-2xl font-semibold text-foreground">Speak an action</Text>
      <Text className="mt-1 text-base text-mutedForeground">
        Hold the mic, say what happened, release. We&apos;ll draft it for your approval.
      </Text>

      <View className="flex-1 items-center justify-center">
        {phase === 'transcript' ? (
          <View className="w-full">
            <Text className="mb-2 text-base text-mutedForeground">Heard</Text>
            <Text className="text-lg text-foreground">{transcript}</Text>
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
              <Text className="text-base font-semibold text-primaryForeground">View approvals</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={reset}
              className="mt-3 min-h-11 items-center justify-center rounded-md border border-border px-4 py-3"
            >
              <Text className="text-base text-foreground">Speak again</Text>
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

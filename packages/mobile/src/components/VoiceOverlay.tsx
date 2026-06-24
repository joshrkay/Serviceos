import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useVoiceCapture } from '../voice/useVoiceCapture';

// The contextual voice affordance the prototype puts on top of every screen
// (handoff README §"Voice capture"): a small mic at the top-center that opens a
// hold-to-talk sheet over the current route. The capture/transcribe logic is
// unchanged (`useVoiceCapture`); this only wires the launch affordance into the
// shared shell so the assistant is reachable without leaving the screen.
export function VoiceOverlay() {
  const [open, setOpen] = useState(false);
  const insets = useSafeAreaInsets();

  return (
    <>
      {/* Sit below the notch / status bar; keep a min when there's no inset. */}
      <View
        className="absolute left-0 right-0 items-center"
        style={{ top: Math.max(insets.top, 8) }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Voice assistant"
          onPress={() => setOpen(true)}
          className="min-h-11 min-w-11 items-center justify-center rounded-full bg-primary px-4 py-2"
        >
          <Text className="text-sm font-semibold text-primaryForeground">Talk</Text>
        </Pressable>
      </View>
      {/* The sheet only mounts when open so `useVoiceCapture` (and its audio
          recorder) is created on demand, not for every screen. */}
      {open ? <VoiceSheet onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function VoiceSheet({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const { phase, transcript, error, startRecording, stopAndTranscribe } = useVoiceCapture();
  const listening = phase === 'listening';
  const busy = phase === 'transcribing';

  return (
    <View className="absolute bottom-0 left-0 right-0 top-0">
      {/* Backdrop — tap to dismiss. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close voice assistant"
        onPress={onClose}
        className="absolute bottom-0 left-0 right-0 top-0 bg-black/50"
      />
      <View className="absolute bottom-0 left-0 right-0 rounded-t-xl bg-card px-6 pb-8 pt-4">
        <View className="flex-row items-center justify-between">
          <Text className="text-base font-semibold text-foreground">Assistant</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close"
            onPress={onClose}
            className="min-h-11 min-w-11 items-center justify-center"
          >
            <Text className="text-base text-mutedForeground">Close</Text>
          </Pressable>
        </View>

        {phase === 'transcript' ? (
          <View className="mt-4">
            <Text className="text-base text-foreground">{transcript}</Text>
            <Text className="mt-2 text-sm text-mutedForeground">
              We&apos;re drafting it — it&apos;ll appear in approvals for your tap.
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                onClose();
                router.push('/approvals');
              }}
              className="mt-4 min-h-11 items-center justify-center rounded-md bg-primary px-4 py-3"
            >
              <Text className="text-base font-semibold text-primaryForeground">View approvals</Text>
            </Pressable>
          </View>
        ) : (
          <View className="mt-4 items-center">
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
              className={`h-20 w-20 items-center justify-center rounded-full ${
                listening ? 'bg-destructive' : 'bg-primary'
              }`}
            >
              {busy ? (
                <ActivityIndicator color="#ffffff" />
              ) : (
                <Text className="text-sm font-semibold text-primaryForeground">
                  {listening ? 'Listening' : 'Hold'}
                </Text>
              )}
            </Pressable>
            <Text className="mt-3 text-sm text-mutedForeground">
              {busy ? 'Uploading & transcribing…' : 'Hold to speak · release to send'}
            </Text>
          </View>
        )}

        {error ? <Text className="mt-3 text-sm text-destructive">{error}</Text> : null}
      </View>
    </View>
  );
}

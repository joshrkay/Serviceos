import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Modal, Pressable, Text, View } from 'react-native';
import { usePendingProposals } from '../hooks/usePendingProposals';
import { useVoiceCapture } from '../voice/useVoiceCapture';

/** Top-center mic affordance on tab screens — hold to capture in an overlay. */
export function VoiceOverlay() {
  const router = useRouter();
  const { refresh } = usePendingProposals();
  const { phase, transcript, error, startRecording, stopAndTranscribe, reset } = useVoiceCapture();
  const [open, setOpen] = useState(false);
  const listening = phase === 'listening';
  const busy = phase === 'transcribing';

  const close = () => {
    setOpen(false);
    reset();
  };

  const onRelease = async () => {
    await stopAndTranscribe();
    void refresh();
  };

  return (
    <>
      <View pointerEvents="box-none" className="absolute left-0 right-0 top-12 z-10 items-center">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Hold to speak"
          onPress={() => setOpen(true)}
          className="min-h-11 min-w-11 items-center justify-center rounded-full bg-primary px-4 shadow-sm"
        >
          <Text className="text-sm font-semibold text-primaryForeground">Mic</Text>
        </Pressable>
      </View>

      <Modal visible={open} animationType="slide" transparent onRequestClose={close}>
        <View className="flex-1 justify-end bg-black/40">
          <View className="rounded-t-2xl bg-background px-6 pb-10 pt-6">
            <Text className="font-heading text-xl font-semibold text-foreground">Speak an action</Text>
            <Text className="mt-1 text-base text-mutedForeground">
              Hold the mic, say what happened, release. We&apos;ll draft it for your approval.
            </Text>

            <View className="my-8 items-center">
              {phase === 'queued' ? (
                <View className="w-full">
                  <Text className="text-lg text-foreground">Saved. Will send when back online.</Text>
                  <Text className="mt-2 text-base text-mutedForeground">
                    Your recording sends automatically when you reconnect, then appears in
                    approvals.
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    onPress={close}
                    className="mt-4 min-h-11 items-center justify-center rounded-md bg-primary px-4 py-3"
                  >
                    <Text className="text-base font-semibold text-primaryForeground">Done</Text>
                  </Pressable>
                </View>
              ) : phase === 'transcript' ? (
                <View className="w-full">
                  <Text className="text-base text-mutedForeground">Heard</Text>
                  <Text className="mt-1 text-lg text-foreground">{transcript}</Text>
                  <Text className="mt-3 text-base text-mutedForeground">
                    Drafting — check Approvals for your proposal.
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                      close();
                      router.push('/approvals');
                    }}
                    className="mt-4 min-h-11 items-center justify-center rounded-md bg-primary px-4 py-3"
                  >
                    <Text className="text-base font-semibold text-primaryForeground">View approvals</Text>
                  </Pressable>
                </View>
              ) : (
                <>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Hold to record"
                    onPressIn={() => void startRecording()}
                    onPressOut={() => void onRelease()}
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
              {error ? <Text className="mt-4 text-base text-destructive">{error}</Text> : null}
            </View>

            <Pressable
              accessibilityRole="button"
              onPress={close}
              className="min-h-11 items-center justify-center rounded-md border border-border px-4 py-3"
            >
              <Text className="text-base text-foreground">Close</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </>
  );
}

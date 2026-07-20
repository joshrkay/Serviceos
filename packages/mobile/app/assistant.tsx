import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useMe } from '../src/hooks/useMe';
import { navModelFor } from '../src/navigation/personaNav';
import { useRecorder } from '../src/voice/useRecorder';
import { useAssistantController } from '../src/assistant/useAssistantController';

/**
 * U13 — conversational assistant. A stateful "talk to the agent" screen over
 * the existing in-app voice-session API; approve-by-voice (F2) rides the same
 * session — a spoken "approve the Rodriguez estimate" surfaces as a proposal
 * chip that deep-links into the EXISTING review screen, where the U1 lane gate
 * (money still confirms on-screen) is untouched. No new approval path.
 *
 * ai:run-gated: technicians lack the permission, so this screen is not in their
 * personaNav quick links and the tech persona is redirected to Today (the same
 * defense-in-depth pattern as app/schedule.tsx).
 */
export default function AssistantScreen() {
  const router = useRouter();
  const { me } = useMe();
  const technicianOnly = me
    ? navModelFor({
        role: me.role,
        currentMode: me.current_mode,
        canFieldServe: me.can_field_serve,
      }).persona === 'tech'
    : false;

  useEffect(() => {
    if (technicianOnly) router.replace('/(tabs)/today');
  }, [technicianOnly, router]);

  const session = useAssistantController();
  const recorder = useRecorder();
  const [draft, setDraft] = useState('');
  const [holding, setHolding] = useState(false);

  if (technicianOnly) return null;

  const { status, turns, proposalIds, error, sttUnavailable } = session;
  const idle = status === 'idle';
  const gone = status === 'expired' || status === 'ended';
  const busy = status === 'starting' || status === 'sending';
  // Once STT is unconfigured (501), voice is unavailable — type-only.
  const showMic = !sttUnavailable && !gone && !idle;

  const onPressIn = () => {
    setHolding(true);
    void recorder.startRecording();
  };
  const onPressOut = async () => {
    setHolding(false);
    const uri = await recorder.stopRecording();
    if (uri) void session.sendAudio(uri);
  };
  const submitDraft = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    void session.sendText(text);
  };

  return (
    <View className="flex-1 bg-background px-6 pb-6 pt-24">
      <Text className="font-heading text-2xl font-semibold text-foreground">Assistant</Text>
      <Text className="mt-1 text-base text-mutedForeground">
        Ask about your business or dictate an action. Anything with money or
        messages still comes back for your approval.
      </Text>

      <ScrollView className="mt-4 flex-1" contentContainerClassName="pb-4">
        {turns.map((turn) => (
          <View
            key={turn.id}
            className={`mb-3 max-w-full rounded-lg px-4 py-3 ${
              turn.role === 'user' ? 'self-end bg-primary' : 'self-start bg-card border border-border'
            }`}
          >
            <Text
              className={`text-base ${
                turn.role === 'user' ? 'text-primaryForeground' : 'text-foreground'
              }`}
            >
              {turn.text}
            </Text>
          </View>
        ))}

        {proposalIds.length > 0 ? (
          <View className="mt-1">
            <Text className="mb-2 text-xs font-medium uppercase tracking-wide text-mutedForeground">
              For your approval
            </Text>
            <View className="flex-row flex-wrap">
              {proposalIds.map((id) => (
                <Pressable
                  key={id}
                  accessibilityRole="button"
                  accessibilityLabel="Review proposal"
                  onPress={() => router.push(`/proposals/${id}`)}
                  className="mb-2 mr-2 min-h-11 items-center justify-center rounded-full border border-border bg-card px-4 py-2"
                >
                  <Text className="text-base text-foreground">Review proposal</Text>
                </Pressable>
              ))}
            </View>
          </View>
        ) : null}
      </ScrollView>

      {error ? (
        <Text className="mb-2 text-base text-destructive">{error.message}</Text>
      ) : null}

      {idle ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Start assistant"
          onPress={() => void session.start()}
          disabled={busy}
          className="min-h-11 items-center justify-center rounded-md bg-primary px-4 py-3"
        >
          {busy ? (
            <ActivityIndicator color="#ffffff" />
          ) : (
            <Text className="text-base font-semibold text-primaryForeground">Start</Text>
          )}
        </Pressable>
      ) : gone ? (
        <View>
          <Text className="mb-2 text-base text-mutedForeground">
            This session ended — start a new one to keep going.
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Start a new session"
            onPress={() => void session.start()}
            className="min-h-11 items-center justify-center rounded-md bg-primary px-4 py-3"
          >
            <Text className="text-base font-semibold text-primaryForeground">Start a new one</Text>
          </Pressable>
        </View>
      ) : (
        <View>
          {sttUnavailable ? (
            <Text className="mb-2 text-sm text-mutedForeground">
              Voice isn't available right now — type your message.
            </Text>
          ) : null}
          <View className="flex-row items-end">
            <TextInput
              className="mr-2 min-h-11 flex-1 rounded-md border border-border bg-card px-3 py-2 text-base text-foreground"
              placeholder="Type a message"
              value={draft}
              onChangeText={setDraft}
              editable={!busy}
              onSubmitEditing={submitDraft}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send message"
              onPress={submitDraft}
              disabled={busy || !draft.trim()}
              className="min-h-11 items-center justify-center rounded-md bg-primary px-4 py-2"
            >
              <Text className="text-base font-semibold text-primaryForeground">Send</Text>
            </Pressable>
          </View>

          {showMic ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Hold to talk"
              onPressIn={onPressIn}
              onPressOut={() => void onPressOut()}
              disabled={busy}
              className={`mt-3 min-h-11 items-center justify-center rounded-md ${
                holding ? 'bg-destructive' : 'border border-border bg-card'
              } px-4 py-3`}
            >
              <Text
                className={`text-base font-semibold ${
                  holding ? 'text-primaryForeground' : 'text-foreground'
                }`}
              >
                {holding ? 'Listening… release to send' : 'Hold to talk'}
              </Text>
            </Pressable>
          ) : null}
        </View>
      )}
    </View>
  );
}

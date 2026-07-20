import { useAuth } from '@clerk/clerk-expo';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { playBase64Tts, streamFetch } from '../src/assistant/nativeAssistantDeps';
import { SESSION_ENDED_COPY, useAssistantSession } from '../src/assistant/useAssistantSession';
import { useMe } from '../src/hooks/useMe';
import { API_BASE_URL } from '../src/lib/env';
import { MIC_PERMISSION_COPY } from '../src/lib/errorCopy';
import { useApiClient } from '../src/lib/useApiClient';
import { navModelFor } from '../src/navigation/personaNav';
import { useHoldToTalkRecorder } from '../src/voice/useHoldToTalkRecorder';

/**
 * Conversational assistant (U13) — a stateful "talk to the agent" session
 * over the voice-session API. Speak or type a turn; the agent answers with
 * text + TTS, and any proposals it drafts surface as chips that deep-link
 * into the existing review screen — approval semantics (lanes, the 5s undo)
 * stay in useProposalReview, unchanged. F2 approve-by-voice rides the same
 * session server-side (proposal-approval-task): money/irreversible readbacks
 * still land on the review screen's confirm gates.
 *
 * Technicians lack the ai:run permission — redirect to Today (same pattern
 * as app/schedule.tsx).
 */
export default function AssistantScreen() {
  const router = useRouter();
  const { me } = useMe();
  const api = useApiClient();
  const { getToken } = useAuth();

  const showAssistant = me
    ? navModelFor({
        role: me.role,
        currentMode: me.current_mode,
        canFieldServe: me.can_field_serve,
      }).showAssistant
    : true; // don't flash the redirect before /api/me resolves

  useEffect(() => {
    if (!showAssistant) router.replace('/(tabs)/today');
  }, [showAssistant, router]);

  const session = useAssistantSession(
    useMemo(
      () => ({
        api,
        streamFetch,
        getToken: (opts?: { forceRefresh?: boolean }) =>
          getToken({ template: 'serviceos', skipCache: opts?.forceRefresh ?? false }),
        baseUrl: API_BASE_URL,
        playTts: playBase64Tts,
      }),
      [api, getToken],
    ),
  );
  const { start, phase } = session;

  const [draft, setDraft] = useState('');
  const [micState, setMicState] = useState<'idle' | 'listening'>('idle');
  const [micError, setMicError] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView | null>(null);

  const recorder = useHoldToTalkRecorder({
    onStarting: () => setMicError(null),
    onListening: () => setMicState('listening'),
    onCancelled: () => setMicState('idle'),
    onClip: async (uri) => {
      setMicState('idle');
      if (uri) await session.sendClip({ fileUri: uri, contentType: 'audio/mp4' });
    },
    onPermissionDenied: () => {
      setMicState('idle');
      setMicError(MIC_PERMISSION_COPY.body);
    },
    onStartError: () => {
      setMicState('idle');
      setMicError('Could not start recording. Please retry.');
    },
  });

  // Auto-start the first conversation once we know the persona may use it.
  useEffect(() => {
    if (showAssistant && me && phase === 'idle') void start();
  }, [showAssistant, me, phase, start]);

  const sendDraft = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    await session.sendText(text);
  };

  if (!showAssistant) return null;

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-background"
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View className="flex-1 px-6 pb-8 pt-16">
        <View className="flex-row items-center justify-between">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back"
            onPress={() => router.back()}
            className="min-h-11 justify-center"
          >
            <Text className="text-base text-mutedForeground">‹ Back</Text>
          </Pressable>
          {phase === 'active' ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="End conversation"
              onPress={() => void session.end()}
              className="min-h-11 justify-center px-2"
            >
              <Text className="text-base text-mutedForeground">End</Text>
            </Pressable>
          ) : null}
        </View>

        <Text className="mt-2 font-heading text-2xl font-semibold text-foreground">Assistant</Text>

        <ScrollView
          ref={scrollRef}
          className="mt-4 flex-1"
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
        >
          {phase === 'starting' ? <ActivityIndicator /> : null}

          {session.turns.map((turn) => (
            <View
              key={turn.id}
              className={`mb-3 max-w-[85%] rounded-lg px-4 py-3 ${
                turn.role === 'agent' ? 'self-start bg-card' : 'self-end bg-primary'
              }`}
            >
              <Text
                className={`text-base ${
                  turn.role === 'agent' ? 'text-foreground' : 'text-primaryForeground'
                }`}
              >
                {turn.text}
              </Text>
            </View>
          ))}

          {session.proposalIds.map((id) => (
            <Pressable
              key={id}
              accessibilityRole="button"
              accessibilityLabel="Review proposal"
              onPress={() => router.push(`/proposals/${id}`)}
              className="mb-3 min-h-11 flex-row items-center justify-between rounded-md border border-primary px-4 py-3"
            >
              <Text className="text-base font-semibold text-primary">Review proposal</Text>
              <Text className="text-base text-primary">→</Text>
            </Pressable>
          ))}

          {phase === 'ended' ? (
            <View className="mt-4">
              <Text className="text-base text-mutedForeground">{SESSION_ENDED_COPY}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Start a new conversation"
                onPress={() => void start()}
                className="mt-3 min-h-11 items-center justify-center rounded-md bg-primary px-4 py-3"
              >
                <Text className="text-base font-semibold text-primaryForeground">
                  Start a new conversation
                </Text>
              </Pressable>
            </View>
          ) : null}

          {phase === 'unavailable' ? (
            <Text className="mt-4 text-base text-mutedForeground">
              The assistant isn&apos;t available for your account.
            </Text>
          ) : null}

          {phase === 'error' && session.error ? (
            <View className="mt-4">
              <Text className="text-base text-destructive">{session.error}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Retry"
                onPress={() => void start()}
                className="mt-3 min-h-11 items-center justify-center rounded-md border border-border px-4 py-3"
              >
                <Text className="text-base text-foreground">Retry</Text>
              </Pressable>
            </View>
          ) : null}
        </ScrollView>

        {phase === 'active' && (session.error || micError) ? (
          <Text className="mb-2 text-sm text-destructive">{session.error ?? micError}</Text>
        ) : null}

        {phase === 'active' ? (
          <View>
            {!session.sttUnavailable ? (
              <View className="mb-3 items-center">
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Hold to talk"
                  onPressIn={() => void recorder.pressIn()}
                  onPressOut={() => void recorder.pressOut()}
                  disabled={session.isSending}
                  className={`h-20 w-20 items-center justify-center rounded-full ${
                    micState === 'listening' ? 'bg-destructive' : 'bg-primary'
                  }`}
                >
                  {session.isSending ? (
                    <ActivityIndicator color="#ffffff" />
                  ) : (
                    <Text className="text-base font-semibold text-primaryForeground">
                      {micState === 'listening' ? '…' : 'Hold'}
                    </Text>
                  )}
                </Pressable>
              </View>
            ) : null}

            <View className="flex-row items-center gap-3">
              <TextInput
                accessibilityLabel="Message the assistant"
                value={draft}
                onChangeText={setDraft}
                placeholder="Type a message"
                placeholderTextColor="#94a3b8"
                className="min-h-11 flex-1 rounded-md border border-border px-4 py-3 text-base text-foreground"
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Send"
                onPress={() => void sendDraft()}
                disabled={session.isSending || !draft.trim()}
                className="min-h-11 items-center justify-center rounded-md bg-primary px-4 py-3"
              >
                <Text className="text-base font-semibold text-primaryForeground">Send</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
      </View>
    </KeyboardAvoidingView>
  );
}

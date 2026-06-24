import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useApiClient } from '../../src/lib/useApiClient';
import { sendReply } from '../../src/messaging/sendReply';
import {
  useConversationThread,
  type ThreadMessage,
} from '../../src/messaging/useConversationThread';
import { ErrorState } from '../../src/components/ErrorState';
import { useToast } from '../../src/components/Toast';
import { formatRelativeTime } from '../../src/lib/format';

function firstParam(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

/** Owner/system messages render on the right; customer texts on the left. */
function isOutbound(m: ThreadMessage): boolean {
  const dir = m.metadata?.['direction'];
  if (dir === 'inbound') return false;
  if (dir === 'outbound') return true;
  return m.senderRole !== 'customer';
}

export default function MessageThread() {
  const params = useLocalSearchParams<{ id: string; title?: string }>();
  const id = firstParam(params.id);
  const title = firstParam(params.title) || 'Conversation';
  const router = useRouter();
  const api = useApiClient();
  const { showErrorToast } = useToast();
  const { messages, isLoading, error, refetch } = useConversationThread(id || null);

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<ThreadMessage[]>([]);

  // Optimistic sends reconcile away once refetch returns the same id.
  const all = [...messages, ...sent.filter((s) => !messages.some((m) => m.id === s.id))];

  const onSend = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      const message = await sendReply(api, id, body);
      setSent((prev) => [...prev, message]);
      setDraft('');
      void refetch();
    } catch (e) {
      // A send failure is a transient action error over a screen the owner wants
      // to keep — surface it as a toast and preserve their draft for a retry.
      showErrorToast(e);
    } finally {
      setSending(false);
    }
  };

  return (
    // The composer is bottom-anchored, so without this the on-screen keyboard
    // covers it on both platforms. `padding` is the iOS-correct behavior;
    // Android resizes its own height. The custom header lives inside the view
    // (no navigation header), so no keyboardVerticalOffset is needed.
    <KeyboardAvoidingView
      className="flex-1 bg-background pt-16"
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View className="px-6">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={() => router.back()}
          className="min-h-11 justify-center"
        >
          <Text className="text-base text-mutedForeground">‹ Messages</Text>
        </Pressable>
        <Text className="mt-2 text-2xl font-semibold text-foreground">{title}</Text>
        {error ? (
          <ErrorState error={error} showRetry onRetry={() => void refetch()} className="mt-2" />
        ) : null}
      </View>

      <FlatList
        data={all}
        keyExtractor={(m) => m.id}
        contentContainerStyle={{ padding: 24 }}
        ListEmptyComponent={
          isLoading ? (
            <ActivityIndicator />
          ) : (
            <Text className="text-base text-mutedForeground">No messages yet — say hello.</Text>
          )
        }
        renderItem={({ item }) => {
          if (item.messageType === 'system_event') {
            return (
              <Text className="mb-3 text-center text-sm text-mutedForeground">{item.content}</Text>
            );
          }
          const outbound = isOutbound(item);
          return (
            <View className={`mb-2 max-w-[80%] ${outbound ? 'self-end items-end' : 'self-start items-start'}`}>
              <View className={`rounded-2xl px-4 py-2 ${outbound ? 'bg-primary' : 'bg-secondary'}`}>
                <Text className={outbound ? 'text-base text-primaryForeground' : 'text-base text-secondaryForeground'}>
                  {item.content}
                </Text>
              </View>
              <Text className="mt-1 text-xs text-mutedForeground">
                {formatRelativeTime(item.createdAt)}
              </Text>
            </View>
          );
        }}
      />

      <View className="border-t border-border px-4 py-3">
        <View className="flex-row items-end gap-2">
          <TextInput
            className="min-h-11 flex-1 rounded-2xl border border-border px-4 py-2 text-base text-foreground"
            placeholder="Type a message"
            value={draft}
            onChangeText={setDraft}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send"
            onPress={() => void onSend()}
            disabled={sending || draft.trim().length === 0}
            className="min-h-11 items-center justify-center rounded-2xl bg-primary px-5"
          >
            {sending ? (
              <ActivityIndicator />
            ) : (
              <Text className="text-base font-semibold text-primaryForeground">Send</Text>
            )}
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

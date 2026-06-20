import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { useConversations, type InboxThread } from '../src/messaging/useConversations';

function threadName(t: InboxThread): string {
  // A friendly title wins; for unmatched-SMS threads the entityId is the phone.
  return t.customerName ?? t.conversation.title ?? t.conversation.entityId ?? 'Conversation';
}

export default function Messages() {
  const router = useRouter();
  const { threads, isLoading, error, refetch } = useConversations();
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await refetch();
    } finally {
      setRefreshing(false);
    }
  };

  const open = (t: InboxThread) => {
    router.push({
      pathname: '/messages/[id]',
      params: { id: t.conversation.id, title: threadName(t) },
    });
  };

  return (
    <View className="flex-1 bg-background pt-16">
      <View className="px-6">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={() => router.back()}
          className="min-h-11 justify-center"
        >
          <Text className="text-base text-mutedForeground">‹ Back</Text>
        </Pressable>
        <Text className="mt-2 text-2xl font-semibold text-foreground">Messages</Text>
        {error ? <Text className="mt-2 text-base text-destructive">{error}</Text> : null}
      </View>

      <FlatList
        data={threads}
        keyExtractor={(t) => t.conversation.id}
        contentContainerStyle={{ padding: 24 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />}
        ListEmptyComponent={
          isLoading ? (
            <ActivityIndicator />
          ) : (
            <Text className="text-base text-mutedForeground">No messages yet.</Text>
          )
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={threadName(item)}
            onPress={() => open(item)}
            className="mb-3 min-h-11 rounded-lg border border-border p-4"
          >
            <View className="flex-row items-center justify-between">
              <Text className="text-base text-foreground">{threadName(item)}</Text>
              {item.needsReply ? (
                <View className="h-2.5 w-2.5 rounded-full bg-primary" accessibilityLabel="Needs reply" />
              ) : null}
            </View>
            <Text className="mt-1 text-sm text-mutedForeground" numberOfLines={1}>
              {item.lastMessageDirection === 'outbound' ? 'You: ' : ''}
              {item.lastMessagePreview}
            </Text>
          </Pressable>
        )}
      />
    </View>
  );
}

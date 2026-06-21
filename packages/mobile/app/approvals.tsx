import { useRouter } from 'expo-router';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { usePendingProposals } from '../src/hooks/usePendingProposals';
import { typeLabel } from '../src/proposals/proposalReview';
import { ErrorState } from '../src/components/ErrorState';

// Approvals inbox: the AI's pending drafts (from voice capture etc.), polled
// live. Tapping a proposal opens the review screen (approve with a 5s undo).
export default function Approvals() {
  const router = useRouter();
  const { proposals, count, isLoading, error, refresh } = usePendingProposals();

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
        <Text className="mt-2 text-2xl font-semibold text-foreground">Approvals</Text>
        <Text className="mt-1 text-base text-mutedForeground">
          {count === 0 ? 'Nothing waiting' : `${count} waiting for you`}
        </Text>
        {error ? <ErrorState error={error} showRetry={false} className="mt-3" /> : null}
      </View>

      <FlatList
        data={proposals}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ padding: 24 }}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={() => void refresh()} />}
        ListEmptyComponent={
          isLoading ? (
            <ActivityIndicator />
          ) : (
            <Text className="text-base text-mutedForeground">
              Speak an action and your drafts will appear here for approval.
            </Text>
          )
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Review ${typeLabel(item.proposalType)}: ${item.summary}`}
            onPress={() => router.push(`/proposals/${item.id}`)}
            className="mb-3 min-h-11 rounded-lg border border-border p-4"
          >
            <Text className="text-sm text-mutedForeground">{typeLabel(item.proposalType)}</Text>
            <Text className="mt-1 text-base text-foreground">{item.summary}</Text>
          </Pressable>
        )}
      />
    </View>
  );
}

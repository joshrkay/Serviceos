import { useRouter } from 'expo-router';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { usePendingProposals } from '../src/hooks/usePendingProposals';

const TYPE_LABEL: Record<string, string> = {
  draft_invoice: 'Invoice',
  issue_invoice: 'Issue invoice',
  send_invoice: 'Send invoice',
  record_payment: 'Payment',
  draft_estimate: 'Estimate',
  send_estimate: 'Send estimate',
  create_appointment: 'Appointment',
  reschedule_appointment: 'Reschedule',
  create_customer: 'Customer',
  voice_clarification: 'Clarify',
};

function label(type: string): string {
  return TYPE_LABEL[type] ?? type.replace(/_/g, ' ');
}

// Approvals inbox: the AI's pending drafts (from voice capture etc.), polled
// live. Tapping into a proposal to review/approve (with the 5s undo) is the
// next unit; this screen surfaces the list + live count.
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
        {error ? <Text className="mt-3 text-base text-destructive">{error}</Text> : null}
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
          <View className="mb-3 rounded-lg border border-border p-4">
            <Text className="text-sm text-mutedForeground">{label(item.proposalType)}</Text>
            <Text className="mt-1 text-base text-foreground">{item.summary}</Text>
          </View>
        )}
      />
    </View>
  );
}

import { ActivityIndicator, FlatList, RefreshControl, Text, View } from 'react-native';
import { ScreenShell } from '../src/components/ScreenShell';
import { usePendingProposals } from '../src/hooks/usePendingProposals';
import { ErrorState } from '../src/components/ErrorState';
import { ProposalCard } from '../src/components/ProposalCard';

export default function Approvals() {
  const { proposals, count, isLoading, error, refresh } = usePendingProposals();

  return (
    <ScreenShell
      title="Approvals"
      subtitle={count === 0 ? 'Nothing waiting' : `${count} waiting for you`}
      scroll={false}
    >
      {error ? <ErrorState error={error} showRetry={false} className="mb-3" /> : null}
      <FlatList
        data={proposals}
        keyExtractor={(item) => item.id}
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
        renderItem={({ item }) => <ProposalCard proposal={item} />}
      />
    </ScreenShell>
  );
}

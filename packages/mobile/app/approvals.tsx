import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, Text } from 'react-native';
import { ScreenShell } from '../src/components/ScreenShell';
import { PrimaryButton } from '../src/components/Buttons';
import { useToast } from '../src/components/Toast';
import { usePendingProposals } from '../src/hooks/usePendingProposals';
import { ErrorState } from '../src/components/ErrorState';
import { ProposalCard } from '../src/components/ProposalCard';
import { requestOfflineFlush } from '../src/offline/flushSignal';
import { isBatchEligible } from '../src/proposals/proposalEvents';
import { useApproveBatch } from '../src/proposals/useApproveBatch';

/** Match owner-operator-app-spec: "Approve all (N)" only when 3+ eligible. */
const BATCH_APPROVE_MIN = 3;

export default function Approvals() {
  const { proposals, count, isLoading, error, refresh } = usePendingProposals();
  const approveBatch = useApproveBatch();
  const { showToast, showErrorToast } = useToast();
  const [batchLoading, setBatchLoading] = useState(false);

  const eligible = useMemo(() => proposals.filter(isBatchEligible), [proposals]);

  const onApproveAll = useCallback(async () => {
    if (eligible.length < BATCH_APPROVE_MIN || batchLoading) return;
    setBatchLoading(true);
    try {
      const result = await approveBatch(eligible.map((p) => p.id));
      await refresh();
      const n = result.approved.length;
      showToast({
        title: n === 1 ? 'Approved 1 proposal' : `Approved ${n} proposals`,
        body:
          result.failed.length > 0
            ? `${result.failed.length} couldn't be approved and ${
                result.failed.length === 1 ? 'is' : 'are'
              } still waiting.`
            : undefined,
        tone: 'info',
      });
    } catch (err) {
      showErrorToast(err);
    } finally {
      setBatchLoading(false);
    }
  }, [approveBatch, batchLoading, eligible, refresh, showErrorToast, showToast]);

  return (
    <ScreenShell
      title="Approvals"
      subtitle={count === 0 ? 'Nothing waiting' : `${count} waiting for you`}
      scroll={false}
      headerRight={
        eligible.length >= BATCH_APPROVE_MIN ? (
          <PrimaryButton
            label={`Approve all (${eligible.length})`}
            loading={batchLoading}
            onPress={() => void onApproveAll()}
            className="shrink-0"
          />
        ) : undefined
      }
    >
      {error ? <ErrorState error={error} showRetry={false} className="mb-3" /> : null}
      <FlatList
        data={proposals}
        keyExtractor={(item) => item.id}
        refreshControl={
          <RefreshControl
            refreshing={isLoading}
            onRefresh={() => {
              // U12 — pull-to-refresh doubles as the offline queue's manual
              // retry: drain anything still journaled, then re-fetch.
              requestOfflineFlush();
              void refresh();
            }}
          />
        }
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

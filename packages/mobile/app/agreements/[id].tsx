import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import {
  cancelAgreement,
  pauseAgreement,
  resumeAgreement,
  type AgreementDetail,
  type AgreementRun,
} from '../../src/api/agreements';
import { DestructiveButton, PrimaryButton, SecondaryButton } from '../../src/components/Buttons';
import { ErrorState } from '../../src/components/ErrorState';
import { LabelValueTable } from '../../src/components/LabelValueTable';
import { ScreenShell } from '../../src/components/ScreenShell';
import { describeRecurrence } from '../../src/agreements/recurrence';
import { useDetailQuery } from '../../src/hooks/useDetailQuery';
import { useMe } from '../../src/hooks/useMe';
import { useSavePhase } from '../../src/hooks/useSavePhase';
import { useApiClient } from '../../src/lib/useApiClient';
import { formatMoneyCents, formatShortDate } from '../../src/lib/format';

function titleCase(value?: string): string {
  if (!value) return '';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function RunRow({ run, timezone, onOpenInvoice }: { run: AgreementRun; timezone?: string; onOpenInvoice: (id: string) => void }) {
  const body = (
    <View className="flex-row items-start justify-between px-4 py-3">
      <View className="flex-1 pr-3">
        <Text className="text-base text-foreground">{formatShortDate(run.scheduledFor, timezone)}</Text>
        {run.errorMessage ? (
          <Text className="mt-0.5 text-sm text-destructive">{run.errorMessage}</Text>
        ) : run.generatedInvoiceId ? (
          <Text className="mt-0.5 text-sm text-mutedForeground">View invoice ›</Text>
        ) : null}
      </View>
      <Text className="text-sm text-mutedForeground">{titleCase(run.status)}</Text>
    </View>
  );
  if (run.generatedInvoiceId) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open invoice from ${formatShortDate(run.scheduledFor, timezone)} run`}
        onPress={() => onOpenInvoice(run.generatedInvoiceId!)}
        className="min-h-11 justify-center"
      >
        {body}
      </Pressable>
    );
  }
  return body;
}

export default function AgreementDetailScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = Array.isArray(params.id) ? params.id[0] : (params.id ?? '');
  const router = useRouter();
  const client = useApiClient();
  const { me } = useMe();
  const { data, isLoading, error, refetch } = useDetailQuery<AgreementDetail>(
    id ? `/api/agreements/${id}` : null,
  );

  const actionPhase = useSavePhase();
  const [confirmCancel, setConfirmCancel] = useState(false);

  const perms = me?.permissions ?? [];
  const canManage = perms.includes('customers:update');
  const canCancel = perms.includes('customers:delete');
  const status = data?.status ?? '';
  const runs = data?.recentRuns ?? [];

  const runAction = (fn: () => Promise<void>) =>
    void actionPhase.run(async () => {
      await fn();
      await refetch();
    });

  return (
    <ScreenShell title={data?.name ?? 'Agreement'} backLabel="‹ Agreements">
      {isLoading ? <ActivityIndicator /> : null}
      {error ? <ErrorState error={error} showRetry onRetry={() => void refetch()} className="mb-4" /> : null}

      {data ? (
        <View>
          <Text className="mb-4 text-2xl font-semibold text-foreground">
            {formatMoneyCents(data.priceCents)}
            <Text className="text-base text-mutedForeground"> · {describeRecurrence(data.recurrenceRule)}</Text>
          </Text>

          <LabelValueTable
            rows={[
              { label: 'Status', value: titleCase(data.status) },
              { label: 'Next run', value: data.nextRunAt ? formatShortDate(data.nextRunAt, me?.timezone) : undefined },
              { label: 'Last run', value: data.lastRunAt ? formatShortDate(data.lastRunAt, me?.timezone) : undefined },
              { label: 'Starts', value: data.startsOn ? formatShortDate(data.startsOn, me?.timezone) : undefined },
              { label: 'Ends', value: data.endsOn ? formatShortDate(data.endsOn, me?.timezone) : undefined },
              { label: 'Auto-invoice', value: data.autoGenerateInvoice ? 'Yes' : 'No' },
              { label: 'Auto-job', value: data.autoGenerateJob ? 'Yes' : 'No' },
              { label: 'Description', value: data.description },
            ]}
          />

          {status === 'cancelled' ? (
            <Text className="mt-6 text-base text-mutedForeground">This agreement was cancelled.</Text>
          ) : canManage || canCancel ? (
            <View className="mt-6 gap-3">
              <Text className="text-xs font-medium uppercase tracking-wide text-mutedForeground">
                Manage
              </Text>

              {canManage && status === 'active' ? (
                <SecondaryButton
                  label={actionPhase.phase === 'saving' ? 'Working…' : 'Pause'}
                  loading={actionPhase.phase === 'saving'}
                  onPress={() => runAction(() => pauseAgreement(client, id))}
                />
              ) : null}

              {canManage && status === 'paused' ? (
                <PrimaryButton
                  label={actionPhase.phase === 'saving' ? 'Working…' : 'Resume'}
                  loading={actionPhase.phase === 'saving'}
                  onPress={() => runAction(() => resumeAgreement(client, id))}
                />
              ) : null}

              {canCancel && !confirmCancel ? (
                <SecondaryButton label="Cancel agreement" onPress={() => setConfirmCancel(true)} />
              ) : null}

              {canCancel && confirmCancel ? (
                <View className="rounded-lg border border-border bg-card p-4">
                  <Text className="text-base font-medium text-foreground">Cancel this agreement?</Text>
                  <Text className="mt-1 text-sm text-mutedForeground">
                    It stops generating jobs and invoices. This can&apos;t be undone.
                  </Text>
                  <View className="mt-3 flex-row gap-2">
                    <SecondaryButton label="Keep it" onPress={() => setConfirmCancel(false)} className="flex-1" />
                    <View className="flex-1">
                      <DestructiveButton
                        label={actionPhase.phase === 'saving' ? 'Cancelling…' : 'Cancel it'}
                        loading={actionPhase.phase === 'saving'}
                        onPress={() =>
                          runAction(async () => {
                            await cancelAgreement(client, id);
                            setConfirmCancel(false);
                          })
                        }
                      />
                    </View>
                  </View>
                </View>
              ) : null}

              {actionPhase.phase === 'error' && actionPhase.error ? (
                <Text className="text-sm text-destructive">{actionPhase.error}</Text>
              ) : null}
            </View>
          ) : null}

          <Text className="mb-2 mt-8 text-xs font-medium uppercase tracking-wide text-mutedForeground">
            Recent runs
          </Text>
          {runs.length === 0 ? (
            <Text className="text-base text-mutedForeground">No runs yet.</Text>
          ) : (
            <View className="rounded-lg border border-border">
              {runs.map((run, i) => (
                <View key={run.id} className={i < runs.length - 1 ? 'border-b border-border' : undefined}>
                  <RunRow
                    run={run}
                    timezone={me?.timezone}
                    onOpenInvoice={(invoiceId) => router.push(`/invoices/${invoiceId}`)}
                  />
                </View>
              ))}
            </View>
          )}
        </View>
      ) : null}
    </ScreenShell>
  );
}

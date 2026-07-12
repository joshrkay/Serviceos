import { type Href, useRouter } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { useMe, type Mode } from '../../src/hooks/useMe';
import { useMoneyDashboard } from '../../src/hooks/useMoneyDashboard';
import { usePendingProposals } from '../../src/hooks/usePendingProposals';
import { formatMoneyShort, formatWeekdayDate } from '../../src/lib/format';
import { greetingForDate } from '../../src/lib/greeting';
import { ErrorState } from '../../src/components/ErrorState';
import { PushDeniedNotice } from '../../src/components/PushDeniedNotice';
import { useToast } from '../../src/components/Toast';
import { useReconnectRetry } from '../../src/lib/useReconnectRetry';

const MODES: Mode[] = ['supervisor', 'both', 'tech'];

const SECONDARY: Array<{ label: string; route: Href }> = [
  { label: 'Messages', route: '/messages' },
  { label: 'Schedule', route: '/schedule' },
  { label: 'Estimates', route: '/estimates' },
  { label: 'Invoices', route: '/invoices' },
  { label: 'Approvals', route: '/approvals' },
];

export default function Home() {
  const router = useRouter();
  const { me, isLoading, error, switchMode, refetch } = useMe();
  const { count: approvalsCount, isLoading: approvalsLoading } = usePendingProposals();
  const money = useMoneyDashboard();
  const { showErrorToast } = useToast();

  useReconnectRetry(refetch, Boolean(error));

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator />
      </View>
    );
  }

  if (error) {
    return (
      <View className="flex-1 items-center justify-center bg-background px-6">
        <ErrorState error={error} onRetry={() => void refetch()} className="w-full" />
      </View>
    );
  }

  const trendUp = (money.summary?.revenueTrendCents ?? 0) >= 0;

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 96, paddingBottom: 96 }}
    >
      <Text className="font-heading text-2xl font-semibold text-foreground">
        {greetingForDate(new Date(), me?.timezone)}
      </Text>
      <Text className="mt-1 text-base text-mutedForeground">
        {formatWeekdayDate(new Date(), me?.timezone)}
      </Text>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Speak an action"
        onPress={() => router.push('/voice')}
        className="mt-6 min-h-11 items-center justify-center rounded-md bg-primary px-4 py-3"
      >
        <Text className="text-base font-semibold text-primaryForeground">Speak an action</Text>
      </Pressable>

      <Text className="mb-2 mt-7 text-xs font-medium uppercase tracking-wide text-mutedForeground">
        Money &amp; approvals
      </Text>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Approval inbox"
        onPress={() => router.push('/approvals')}
        className="min-h-11 flex-row items-center justify-between rounded-lg border border-border bg-card p-4"
      >
        <View className="flex-1 pr-3">
          <Text className="text-base font-medium text-foreground">Approval inbox</Text>
          <Text className="mt-0.5 text-sm text-mutedForeground">
            {approvalsLoading && approvalsCount === 0
              ? 'Checking…'
              : approvalsCount > 0
                ? `${approvalsCount} waiting for your tap`
                : "Nothing waiting — you're caught up"}
          </Text>
        </View>
        {approvalsCount > 0 ? (
          <View className="h-7 min-w-7 items-center justify-center rounded-full bg-primary px-2">
            <Text className="text-sm font-semibold text-primaryForeground">
              {approvalsCount > 9 ? '9+' : approvalsCount}
            </Text>
          </View>
        ) : null}
      </Pressable>

      {money.notConfigured ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Money summary"
          onPress={() => router.push('/invoices')}
          className="mt-3 min-h-11 rounded-lg border border-border bg-card p-4"
        >
          <Text className="text-base font-medium text-foreground">This month</Text>
          {money.isLoading ? (
            <Text className="mt-0.5 text-sm text-mutedForeground">Loading…</Text>
          ) : money.error ? (
            <Text className="mt-0.5 text-sm text-destructive">Couldn&apos;t load money summary</Text>
          ) : money.summary ? (
            <>
              <Text className="mt-1 text-sm text-mutedForeground">
                {formatMoneyShort(money.summary.revenueCents)} collected
                {money.summary.revenueTrendCents !== 0
                  ? ` (${trendUp ? '+' : ''}${formatMoneyShort(money.summary.revenueTrendCents)} vs last month)`
                  : ''}
              </Text>
              <Text className="mt-1 text-sm text-mutedForeground">
                {formatMoneyShort(money.summary.outstandingCents)} outstanding
                {money.summary.overdueCents > 0
                  ? ` · ${formatMoneyShort(money.summary.overdueCents)} overdue`
                  : ''}
              </Text>
            </>
          ) : (
            <Text className="mt-0.5 text-sm text-mutedForeground">View revenue and invoices</Text>
          )}
        </Pressable>
      )}

      <Text className="mb-2 mt-7 text-xs font-medium uppercase tracking-wide text-mutedForeground">
        Switch mode
      </Text>
      <View className="flex-row gap-2">
        {MODES.map((m) => {
          const active = me?.current_mode === m;
          return (
            <Pressable
              key={m}
              accessibilityRole="button"
              accessibilityLabel={`Switch to ${m} mode`}
              onPress={() => {
                void switchMode(m).catch((e) => showErrorToast(e));
              }}
              className={`min-h-11 flex-1 items-center justify-center rounded-md px-3 py-2 ${
                active ? 'bg-primary' : 'bg-secondary'
              }`}
            >
              <Text className={active ? 'text-primaryForeground' : 'text-secondaryForeground'}>
                {m}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <PushDeniedNotice className="mt-6" />

      <Text className="mb-2 mt-7 text-xs font-medium uppercase tracking-wide text-mutedForeground">
        Quick links
      </Text>
      <View className="flex-row flex-wrap justify-between">
        {SECONDARY.map((n) => (
          <Pressable
            key={n.label}
            accessibilityRole="button"
            accessibilityLabel={n.label}
            onPress={() => router.push(n.route)}
            className="mb-3 min-h-11 items-center justify-center rounded-md border border-border bg-card px-4 py-3"
            style={{ width: '47%' }}
          >
            <Text className="text-base text-foreground">{n.label}</Text>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

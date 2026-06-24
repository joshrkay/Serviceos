import { type Href, useRouter } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { useMe, type Mode } from '../src/hooks/useMe';
import { useMoneyDashboard } from '../src/hooks/useMoneyDashboard';
import { usePendingProposals } from '../src/hooks/usePendingProposals';
import { hoursUntilExpiry } from '../src/proposals/proposalEvents';
import { formatMoneyShort, formatWeekdayDate } from '../src/lib/format';
import { greetingForDate } from '../src/lib/greeting';
import { ErrorState } from '../src/components/ErrorState';
import { PushDeniedNotice } from '../src/components/PushDeniedNotice';
import { useToast } from '../src/components/Toast';
import { useReconnectRetry } from '../src/lib/useReconnectRetry';

const MODES: Mode[] = ['supervisor', 'both', 'tech'];

// Secondary destinations that are NOT on the bottom tab bar (Home / Assistant /
// Customers / Jobs / Settings live there). Surfaced here so nothing becomes
// unreachable until later slices reach them contextually.
const QUICK_LINKS: Array<{ label: string; route: Href }> = [
  { label: 'Schedule', route: '/schedule' },
  { label: 'Estimates', route: '/estimates' },
  { label: 'Invoices', route: '/invoices' },
  { label: 'Messages', route: '/messages' },
];

// The dashboard previews the top of the queue; the full list is one tap away.
const MAX_APPROVAL_ROWS = 3;

// Home / Today: the owner's at-a-glance dashboard — what's waiting for approval
// (the human gate, front and center), this month's money, and quick links —
// all over the existing API hooks.
export default function Home() {
  const router = useRouter();
  const { me, isLoading, error, switchMode, refetch } = useMe();
  const { count: approvalsCount, proposals } = usePendingProposals();
  const money = useMoneyDashboard();
  const { showErrorToast } = useToast();

  // If /api/me failed while offline, heal Home on reconnect without a manual tap.
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
  const topProposals = proposals.slice(0, MAX_APPROVAL_ROWS);

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 64, paddingBottom: 48 }}
    >
      <Text className="text-2xl font-semibold text-foreground">{greetingForDate()}</Text>
      <Text className="mt-1 text-base text-mutedForeground">{formatWeekdayDate(new Date())}</Text>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Speak an action"
        onPress={() => router.push('/voice')}
        className="mt-6 min-h-11 items-center justify-center rounded-md bg-primary px-4 py-3"
      >
        <Text className="text-base font-semibold text-primaryForeground">Speak an action</Text>
      </Pressable>

      {/* Pending approvals — the human-approval gate, front and center, with a
          preview of the top of the queue. */}
      <Text className="mt-7 mb-2 text-xs font-medium uppercase tracking-wide text-mutedForeground">
        Pending approvals
      </Text>
      <View className="rounded-xl border border-border bg-card p-4">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Approval inbox"
          onPress={() => router.push('/approvals')}
          className="min-h-11 flex-row items-center justify-between"
        >
          <View className="flex-1 pr-3">
            <Text className="text-base font-medium text-foreground">Approval inbox</Text>
            <Text className="mt-0.5 text-sm text-mutedForeground">
              {approvalsCount > 0
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

        {topProposals.length > 0 ? (
          <View className="mt-3 border-t border-border">
            {topProposals.map((p) => {
              const hrs = hoursUntilExpiry(p.expiresAt);
              return (
                <Pressable
                  key={p.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Review: ${p.summary}`}
                  onPress={() => router.push(`/proposals/${p.id}`)}
                  className="min-h-11 flex-row items-center justify-between border-b border-border py-2"
                >
                  <Text className="flex-1 pr-3 text-sm text-foreground" numberOfLines={1}>
                    {p.summary}
                  </Text>
                  {hrs !== null ? (
                    <Text className="mr-3 text-xs text-mutedForeground">{hrs}h</Text>
                  ) : null}
                  <Text className="text-sm font-medium text-primary">Review</Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}
      </View>

      {/* This month's money — hidden entirely when the report isn't configured. */}
      {money.notConfigured ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Money summary"
          onPress={() => router.push('/invoices')}
          className="mt-7 min-h-11 rounded-xl border border-border bg-card p-4"
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

      <Text className="mt-7 mb-2 text-xs font-medium uppercase tracking-wide text-mutedForeground">
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

      <Text className="mt-7 mb-2 text-xs font-medium uppercase tracking-wide text-mutedForeground">
        Quick links
      </Text>
      <View className="flex-row flex-wrap justify-between">
        {QUICK_LINKS.map((n) => (
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

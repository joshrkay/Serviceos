import { useRouter } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { useMe, type Mode } from '../../src/hooks/useMe';
import { useMoneyDashboard } from '../../src/hooks/useMoneyDashboard';
import { usePendingProposals } from '../../src/hooks/usePendingProposals';
import { formatMoneyShort, formatWeekdayDate } from '../../src/lib/format';
import { greetingForDate } from '../../src/lib/greeting';
import { EmergencyBanner } from '../../src/components/EmergencyBanner';
import { ErrorState } from '../../src/components/ErrorState';
import { PushDeniedNotice } from '../../src/components/PushDeniedNotice';
import { useToast } from '../../src/components/Toast';
import { useListQuery } from '../../src/hooks/useListQuery';
import { formatRelativeTime } from '../../src/lib/format';
import { useReconnectRetry } from '../../src/lib/useReconnectRetry';
import { navModelFor } from '../../src/navigation/personaNav';
import { typeLabel } from '../../src/proposals/proposalReview';

const MODES: Mode[] = ['supervisor', 'both', 'tech'];

function ApprovalsCard() {
  const router = useRouter();
  const { count: approvalsCount, isLoading: approvalsLoading } = usePendingProposals();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Approval inbox"
      onPress={() => router.push('/approvals')}
      className="min-h-11 w-full max-w-full flex-row items-center justify-between rounded-lg border border-border bg-card p-4"
    >
      <View className="min-w-0 flex-1 pr-3">
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
  );
}

function MoneyCard() {
  const router = useRouter();
  const money = useMoneyDashboard();
  const trendUp = (money.summary?.revenueTrendCents ?? 0) >= 0;

  if (money.notConfigured) return null;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Money summary"
      onPress={() => router.push('/invoices')}
      className="mt-3 min-h-11 w-full max-w-full rounded-lg border border-border bg-card p-4"
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
  );
}

interface ExecutedProposalRow {
  id: string;
  summary: string;
  proposalType: string;
  updatedAt?: string;
  createdAt?: string;
}

// U4 — the executed-proposal feed from the spec's Home wireframe ("Recent
// activity"): what the AI just finished on the owner's behalf. Hidden while
// empty so a quiet morning keeps a calm Home.
function RecentActivity({ timezone }: { timezone?: string }) {
  const { data } = useListQuery<ExecutedProposalRow>('/api/proposals', {
    params: { status: 'executed', limit: '5' },
  });
  if (data.length === 0) return null;

  return (
    <>
      <Text className="mb-2 mt-7 text-xs font-medium uppercase tracking-wide text-mutedForeground">
        Recent activity
      </Text>
      <View className="w-full max-w-full rounded-lg border border-border bg-card">
        {data.map((p, i) => (
          <View
            key={p.id}
            className={`flex-row items-center justify-between px-4 py-3 ${
              i > 0 ? 'border-t border-border' : ''
            }`}
          >
            <View className="min-w-0 flex-1 pr-3">
              <Text className="text-base text-foreground" numberOfLines={1}>
                ✓ {p.summary || typeLabel(p.proposalType)}
              </Text>
            </View>
            <Text className="text-sm text-mutedForeground">
              {formatRelativeTime(p.updatedAt ?? p.createdAt, Date.now(), timezone)}
            </Text>
          </View>
        ))}
      </View>
    </>
  );
}

export default function Home() {
  const router = useRouter();
  const { me, isLoading, error, switchMode, refetch } = useMe();
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

  if (!me) {
    return (
      <View className="flex-1 items-center justify-center bg-background px-6">
        <ErrorState error={new Error('Account details are unavailable')} onRetry={() => void refetch()} />
      </View>
    );
  }

  const nav = navModelFor({
    role: me.role,
    currentMode: me.current_mode,
    canFieldServe: me.can_field_serve,
  });

  return (
    <ScrollView
      className="w-full max-w-full flex-1 bg-background"
      contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 96, paddingBottom: 96 }}
    >
      <Text className="font-heading text-2xl font-semibold text-foreground">
        {greetingForDate(new Date(), me?.timezone)}
      </Text>
      <Text className="mt-1 text-base text-mutedForeground">
        {formatWeekdayDate(new Date(), me?.timezone)}
      </Text>

      {/* U4 (B7) — escalation/emergency banner; renders only while raised. */}
      <EmergencyBanner />

      {nav.home.showToday ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open Today"
          onPress={() => router.push('/today')}
          className="mt-6 min-h-11 w-full max-w-full rounded-xl bg-primary px-5 py-4"
        >
          <Text className="font-heading text-lg font-semibold text-primaryForeground">
            Open Today
          </Text>
          <Text className="mt-1 text-sm text-primaryForeground">
            Visits, directions, and customer updates
          </Text>
        </Pressable>
      ) : null}

      {nav.home.showVoice ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Speak an action"
          onPress={() => router.push('/voice')}
          className={`${nav.home.showToday ? 'mt-3' : 'mt-6'} min-h-11 w-full max-w-full items-center justify-center rounded-md bg-primary px-4 py-3`}
        >
          <Text className="text-base font-semibold text-primaryForeground">Speak an action</Text>
        </Pressable>
      ) : null}

      {nav.home.showApprovals || nav.home.showMoney ? (
        <>
          <Text className="mb-2 mt-7 text-xs font-medium uppercase tracking-wide text-mutedForeground">
            {nav.home.showMoney ? 'Money & approvals' : 'Approvals'}
          </Text>
          {nav.home.showApprovals ? <ApprovalsCard /> : null}
          {nav.home.showMoney ? <MoneyCard /> : null}
        </>
      ) : null}

      <RecentActivity timezone={me?.timezone} />

      {nav.showModeToggle ? (
        <>
          <Text className="mb-2 mt-7 text-xs font-medium uppercase tracking-wide text-mutedForeground">
            Switch mode
          </Text>
          <View className="w-full max-w-full flex-row gap-2">
            {MODES.map((mode) => {
              const active = me.current_mode === mode;
              return (
                <Pressable
                  key={mode}
                  accessibilityRole="button"
                  accessibilityLabel={`Switch to ${mode} mode`}
                  onPress={() => {
                    void switchMode(mode).catch((caught: unknown) => {
                      const failure =
                        caught instanceof Error ? caught : new Error('Could not switch mode');
                      showErrorToast(failure);
                    });
                  }}
                  className={`min-h-11 min-w-0 flex-1 items-center justify-center rounded-md px-2 py-2 ${
                    active ? 'bg-primary' : 'bg-secondary'
                  }`}
                >
                  <Text className={active ? 'text-primaryForeground' : 'text-secondaryForeground'}>
                    {mode}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </>
      ) : null}

      <PushDeniedNotice className="mt-6" />

      <Text className="mb-2 mt-7 text-xs font-medium uppercase tracking-wide text-mutedForeground">
        Quick links
      </Text>
      <View className="w-full max-w-full flex-row flex-wrap justify-between">
        {nav.quickLinks.map((link) => (
          <Pressable
            key={link.label}
            accessibilityRole="button"
            accessibilityLabel={link.label}
            onPress={() => router.push(link.route)}
            className="mb-3 min-h-11 min-w-0 items-center justify-center rounded-md border border-border bg-card px-3 py-3"
            style={{ width: '47%' }}
          >
            <Text className="text-base text-foreground">{link.label}</Text>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

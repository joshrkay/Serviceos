import { ActivityIndicator, Text, View } from 'react-native';
import { useDetailQuery } from '../hooks/useDetailQuery';
import { formatMoneyCents } from '../lib/format';

/** Per-job P&L rollup from GET /api/reports/job-profit/:jobId (integer cents). */
export interface JobProfit {
  revenueCents: number;
  laborCents: number | null;
  laborMinutes: number;
  materialsCents: number;
  expensesCents: number;
  marginCents: number;
  marginPct: number | null;
  laborUnpriced: boolean;
}

export interface JobCostCardProps {
  jobId: string;
  /**
   * Whether the caller may read job money (server gates on `invoices:view` —
   * owner/dispatcher, not technician). When false the card renders nothing and
   * never fetches, so a technician's job detail simply omits it.
   */
  enabled: boolean;
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <View className="flex-row justify-between px-4 py-3">
      <Text className={`text-base ${muted ? 'text-mutedForeground' : 'text-foreground'}`}>{label}</Text>
      <Text className={`text-base ${muted ? 'text-mutedForeground' : 'text-foreground'}`}>{value}</Text>
    </View>
  );
}

/**
 * "How did I do on that job?" — revenue minus labor, materials, and expenses.
 * Expenses (logged via the voice `log_expense` proposal) surface here as a
 * first-class P&L line; the API exposes no per-expense list, so this rollup is
 * the read surface. Money is integer cents throughout.
 */
export function JobCostCard({ jobId, enabled }: JobCostCardProps) {
  const { data, isLoading, error } = useDetailQuery<JobProfit>(
    enabled && jobId ? `/api/reports/job-profit/${jobId}` : null,
  );

  if (!enabled) return null;

  return (
    <View className="mt-6">
      <Text className="mb-2 text-xs font-medium uppercase tracking-wide text-mutedForeground">
        Job cost &amp; profit
      </Text>
      {isLoading ? (
        <ActivityIndicator />
      ) : error ? (
        <Text className="text-sm text-mutedForeground">Couldn&apos;t load the job&apos;s numbers.</Text>
      ) : data ? (
        <View className="rounded-lg border border-border">
          <Row label="Revenue" value={formatMoneyCents(data.revenueCents)} />
          <Row
            label={data.laborUnpriced ? 'Labor (rate unset)' : 'Labor'}
            value={data.laborUnpriced ? '—' : formatMoneyCents(data.laborCents ?? 0)}
            muted
          />
          {data.materialsCents > 0 ? (
            <Row label="Materials" value={formatMoneyCents(data.materialsCents)} muted />
          ) : null}
          <Row label="Expenses" value={formatMoneyCents(data.expensesCents)} muted />
          <View className="border-t border-border">
            <Row
              label={data.marginPct !== null ? `Margin (${data.marginPct}%)` : 'Margin'}
              value={formatMoneyCents(data.marginCents)}
            />
          </View>
          {data.laborUnpriced ? (
            <Text className="px-4 pb-3 text-xs text-mutedForeground">
              Not counting your labor — set an hourly rate in settings.
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

import { useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Text, View } from 'react-native';
import { PrimaryButton } from '../../src/components/Buttons';
import { ErrorState } from '../../src/components/ErrorState';
import { LabelValueTable } from '../../src/components/LabelValueTable';
import { ScreenShell } from '../../src/components/ScreenShell';
import { sendEstimate } from '../../src/api/estimates';
import { groupEstimateTiers, type TierLine, type TierLineInput } from '../../src/estimates/tierGroups';
import { useDetailQuery } from '../../src/hooks/useDetailQuery';
import { useSavePhase } from '../../src/hooks/useSavePhase';
import { useApiClient } from '../../src/lib/useApiClient';
import { formatMoneyCents, formatShortDate } from '../../src/lib/format';
import { useApiClient } from '../../src/lib/useApiClient';

interface EstimateDetail {
  id: string;
  estimateNumber?: string;
  status?: string;
  validUntil?: string;
  lineItems?: TierLineInput[];
  totals?: { totalCents?: number; subtotalCents?: number; taxCents?: number };
  customer?: {
    displayName?: string;
    firstName?: string;
    lastName?: string;
    email?: string;
  };
}

function customerName(est?: EstimateDetail): string | undefined {
  const c = est?.customer;
  if (!c) return undefined;
  return c.displayName || [c.firstName, c.lastName].filter(Boolean).join(' ');
}

// Draft/ready/sent estimates can be sent (or re-sent); accepted/rejected/
// expired are terminal for the operator — the customer decides from here.
const SENDABLE = new Set(['draft', 'ready_for_review', 'sent']);

function TierLineRow({
  line,
  emphasize,
  showBorder,
}: {
  line: TierLine;
  emphasize?: boolean;
  showBorder?: boolean;
}) {
  return (
    <View
      className={`flex-row items-start justify-between px-4 py-3 ${
        showBorder ? 'border-b border-border' : ''
      } ${line.isDefaultSelected ? 'bg-primary/5' : ''}`}
    >
      <View className="flex-1 pr-3">
        <Text className={`text-base ${emphasize ? 'font-medium text-foreground' : 'text-foreground'}`}>
          {line.description || 'Item'}
        </Text>
        {line.isDefaultSelected ? (
          <Text className="mt-0.5 text-xs font-medium uppercase tracking-wide text-primary">
            Recommended
          </Text>
        ) : null}
      </View>
      <Text className="text-base text-foreground">{formatMoneyCents(line.totalCents)}</Text>
    </View>
  );
}

/** Bordered card wrapping a set of tier rows (explicit per-row borders — RN has
 * no border-collapse, so `divide-*` utilities don't apply). */
function LineCard({ lines, emphasizeSelected }: { lines: TierLine[]; emphasizeSelected?: boolean }) {
  return (
    <View className="rounded-lg border border-border">
      {lines.map((line, i) => (
        <TierLineRow
          key={line.id ?? `row-${i}`}
          line={line}
          emphasize={emphasizeSelected && line.isDefaultSelected}
          showBorder={i < lines.length - 1}
        />
      ))}
    </View>
  );
}

export default function EstimateDetailScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = Array.isArray(params.id) ? params.id[0] : (params.id ?? '');
  const client = useApiClient();
  const { data, isLoading, error, refetch } = useDetailQuery<EstimateDetail>(
    id ? `/api/estimates/${id}` : null,
  );
  const sendPhase = useSavePhase();

  // A7 — estimate nudge. Only a SENT estimate that the customer hasn't yet
  // accepted/rejected/expired can be nudged; those terminal states get no
  // forward action. The nudge is a comms-lane action, so it sits behind the
  // same explicit confirm as the invoice Send (U1/U5 pattern).
  const [nudging, setNudging] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const title = data?.estimateNumber ?? (id ? `Estimate ${id.slice(0, 8)}` : 'Estimate');
  const grouped = groupEstimateTiers(data?.lineItems);
  const status = data?.status ?? '';
  const canSend = SENDABLE.has(status);

  const onSend = () =>
    void sendPhase.run(async () => {
      await sendEstimate(client, id);
      await refetch();
    });

  return (
    <ScreenShell title={title} backLabel="‹ Estimates">
      {isLoading ? <ActivityIndicator /> : null}
      {error ? <ErrorState error={error} showRetry onRetry={() => void refetch()} className="mb-4" /> : null}

      {data ? (
        <>
          <Text className="mb-1 text-2xl font-semibold text-foreground">
            {formatMoneyCents(data.totals?.totalCents ?? 0)}
          </Text>
          {grouped.hasTiers ? (
            <Text className="mb-4 text-sm text-mutedForeground">
              Total reflects the recommended option
            </Text>
          ) : null}

          <LabelValueTable
            rows={[
              { label: 'Status', value: data.status },
              { label: 'Valid until', value: data.validUntil ? formatShortDate(data.validUntil) : undefined },
              { label: 'Customer', value: customerName(data) },
              { label: 'Email', value: data.customer?.email },
              { label: 'Subtotal', value: formatMoneyCents(data.totals?.subtotalCents ?? 0) },
              { label: 'Tax', value: formatMoneyCents(data.totals?.taxCents ?? 0) },
            ]}
          />

          {grouped.baseLines.length > 0 ? (
            <View className="mt-6">
              <Text className="mb-2 text-xs font-medium uppercase tracking-wide text-mutedForeground">
                Included
              </Text>
              <LineCard lines={grouped.baseLines} />
            </View>
          ) : null}

          {grouped.tierGroups.map((group, gi) => (
            <View key={group.groupKey} className="mt-6">
              <Text className="mb-2 text-xs font-medium uppercase tracking-wide text-mutedForeground">
                {group.groupLabel || `Options ${gi + 1}`} — choose one
              </Text>
              <LineCard lines={group.options} emphasizeSelected />
            </View>
          ))}

          {grouped.addOns.length > 0 ? (
            <View className="mt-6">
              <Text className="mb-2 text-xs font-medium uppercase tracking-wide text-mutedForeground">
                Optional add-ons
              </Text>
              <LineCard lines={grouped.addOns} />
            </View>
          ) : null}

          {canSend ? (
            <View className="mt-8">
              <PrimaryButton
                label={
                  sendPhase.phase === 'saving'
                    ? 'Sending…'
                    : status === 'sent'
                      ? 'Resend estimate'
                      : 'Send estimate'
                }
                loading={sendPhase.phase === 'saving'}
                onPress={onSend}
              />
              {sendPhase.phase === 'error' && sendPhase.error ? (
                <Text className="mt-2 text-sm text-destructive">{sendPhase.error}</Text>
              ) : null}
              {sendPhase.phase === 'saved' ? (
                <Text className="mt-2 text-sm text-success">Sent to the customer.</Text>
              ) : null}
            </View>
          ) : null}
        </>
      ) : null}
    </ScreenShell>
  );
}

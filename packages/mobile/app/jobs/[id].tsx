import { useLocalSearchParams, useRouter } from 'expo-router';
import { ActivityIndicator, Linking, Platform, Pressable, Text, View } from 'react-native';
import { ErrorState } from '../../src/components/ErrorState';
import { JobCostCard } from '../../src/components/JobCostCard';
import { ScreenShell } from '../../src/components/ScreenShell';
import { LabelValueTable } from '../../src/components/LabelValueTable';
import { useDetailQuery } from '../../src/hooks/useDetailQuery';
import { useMe } from '../../src/hooks/useMe';
import { jobRowText } from '../../src/lib/jobRow';
import { buildMapsUrl, buildSmsUrl, type DevicePlatform } from '../../src/lib/deviceLinks';

interface JobDetail {
  id: string;
  jobNumber?: string;
  summary?: string;
  status?: string;
  customer?: {
    displayName?: string;
    firstName?: string;
    lastName?: string;
    primaryPhone?: string;
  };
  location?: {
    street1?: string;
    street2?: string;
    city?: string;
    state?: string;
    postalCode?: string;
  };
}

function customerName(job?: JobDetail): string | undefined {
  const c = job?.customer;
  if (!c) return undefined;
  return c.displayName || [c.firstName, c.lastName].filter(Boolean).join(' ');
}

/** Single-line address for display and maps routing, or undefined when unknown. */
function jobAddress(job?: JobDetail | null): string | undefined {
  const loc = job?.location;
  if (!loc) return undefined;
  const line = [loc.street1, loc.street2, loc.city, loc.state, loc.postalCode]
    .filter(Boolean)
    .join(', ');
  return line || undefined;
}

export default function JobDetailScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = Array.isArray(params.id) ? params.id[0] : (params.id ?? '');
  const router = useRouter();
  const { me } = useMe();
  const { data, isLoading, error, refetch } = useDetailQuery<JobDetail>(
    id ? `/api/jobs/${id}` : null,
  );
  // Job money (revenue/expenses/margin) is owner/dispatcher-only server-side.
  const canViewMoney = (me?.permissions ?? []).includes('invoices:view');

  const headline = data ? jobRowText(data).primary : 'Job';
  const locationLine = jobAddress(data);

  const smsUrl = buildSmsUrl(data?.customer?.primaryPhone);
  const mapsUrl = buildMapsUrl(locationLine, Platform.OS as DevicePlatform);

  return (
    <ScreenShell title={headline} backLabel="‹ Jobs">
      {isLoading ? <ActivityIndicator /> : null}
      {error ? <ErrorState error={error} showRetry onRetry={() => void refetch()} className="mb-4" /> : null}

      {data ? (
        <View>
          <View className="mb-4 flex-row gap-2">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={smsUrl ? 'Message customer' : 'Message unavailable — no phone on file'}
              disabled={!smsUrl}
              onPress={() => smsUrl && void Linking.openURL(smsUrl)}
              className={`min-h-11 flex-1 items-center justify-center rounded-md bg-primary px-4 py-3 ${
                smsUrl ? '' : 'opacity-50'
              }`}
            >
              <Text className="text-base font-semibold text-primaryForeground">Message</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={mapsUrl ? 'Navigate to job address' : 'Navigate unavailable — no address on file'}
              disabled={!mapsUrl}
              onPress={() => mapsUrl && void Linking.openURL(mapsUrl)}
              className={`min-h-11 flex-1 items-center justify-center rounded-md border border-border px-4 py-3 ${
                mapsUrl ? '' : 'opacity-50'
              }`}
            >
              <Text className="text-base text-foreground">Navigate</Text>
            </Pressable>
          </View>

          <LabelValueTable
            rows={[
              { label: 'Job #', value: data.jobNumber },
              { label: 'Status', value: data.status },
              { label: 'Customer', value: customerName(data) },
              { label: 'Location', value: locationLine },
              { label: 'Summary', value: data.summary },
            ]}
          />

          <JobCostCard jobId={id} enabled={canViewMoney} />
          {/* E8 (request-feedback) — DEFERRED, mirrors the invoice A8/A9 note.
              request_feedback is a comms proposal type with NO client mint path:
              POST /api/proposals only accepts the four scheduling types, and no
              direct POST /api/jobs/:id/request-feedback route exists. The server
              already auto-asks 24h after completion (review-request sweep). Until
              a direct route lands, surface the sanctioned voice affordance so the
              owner can still send it on demand. */}
          {data.status === 'completed' ? (
            <Text className="mt-4 text-sm text-mutedForeground">
              A feedback request goes out automatically the day after completion. To ask now,
              say it out loud — it lands in Approvals for you to confirm.
            </Text>
          ) : null}

          <Text className="mb-2 mt-6 text-xs font-medium uppercase tracking-wide text-mutedForeground">
            Job tools
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push({ pathname: '/voice', params: { jobId: id } })}
            className="mb-2 min-h-11 rounded-lg border border-border bg-card px-4 py-3"
          >
            <Text className="text-base font-medium text-foreground">Voice update</Text>
            <Text className="mt-0.5 text-sm text-mutedForeground">
              Describe work, notes, or changes hands-free
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push(`/jobs/${id}/photos`)}
            className="mb-2 min-h-11 rounded-lg border border-border bg-card px-4 py-3"
          >
            <Text className="text-base font-medium text-foreground">Photos</Text>
            <Text className="mt-0.5 text-sm text-mutedForeground">Before/after and site photos</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push(`/jobs/${id}/time`)}
            className="mb-2 min-h-11 rounded-lg border border-border bg-card px-4 py-3"
          >
            <Text className="text-base font-medium text-foreground">Time</Text>
            <Text className="mt-0.5 text-sm text-mutedForeground">Clock in and out on site</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push(`/jobs/${id}/expenses`)}
            className="mb-2 min-h-11 rounded-lg border border-border bg-card px-4 py-3"
          >
            <Text className="text-base font-medium text-foreground">Expenses</Text>
            <Text className="mt-0.5 text-sm text-mutedForeground">Log materials and costs</Text>
          </Pressable>
        </View>
      ) : null}
    </ScreenShell>
  );
}

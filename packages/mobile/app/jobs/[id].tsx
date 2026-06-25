import { useLocalSearchParams, useRouter } from 'expo-router';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { ErrorState } from '../../src/components/ErrorState';
import { ScreenShell } from '../../src/components/ScreenShell';
import { LabelValueTable } from '../../src/components/LabelValueTable';
import { useDetailQuery } from '../../src/hooks/useDetailQuery';
import { jobRowText } from '../../src/lib/jobRow';

interface JobDetail {
  id: string;
  jobNumber?: string;
  summary?: string;
  status?: string;
  customer?: {
    displayName?: string;
    firstName?: string;
    lastName?: string;
  };
  location?: {
    street1?: string;
    city?: string;
    state?: string;
  };
}

function customerName(job?: JobDetail): string | undefined {
  const c = job?.customer;
  if (!c) return undefined;
  return c.displayName || [c.firstName, c.lastName].filter(Boolean).join(' ');
}

export default function JobDetailScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = Array.isArray(params.id) ? params.id[0] : (params.id ?? '');
  const router = useRouter();
  const { data, isLoading, error, refetch } = useDetailQuery<JobDetail>(
    id ? `/api/jobs/${id}` : null,
  );

  const headline = data ? jobRowText(data).primary : 'Job';
  const locationLine = data?.location
    ? [data.location.street1, data.location.city, data.location.state].filter(Boolean).join(', ')
    : undefined;

  return (
    <ScreenShell title={headline} backLabel="‹ Jobs">
      {isLoading ? <ActivityIndicator /> : null}
      {error ? <ErrorState error={error} showRetry onRetry={() => void refetch()} className="mb-4" /> : null}

      {data ? (
        <View>
          <View className="mb-4 flex-row gap-2">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Message"
              onPress={() => {}}
              className="min-h-11 flex-1 items-center justify-center rounded-md bg-primary px-4 py-3"
            >
              <Text className="text-base font-semibold text-primaryForeground">Message</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Navigate"
              onPress={() => {}}
              className="min-h-11 flex-1 items-center justify-center rounded-md border border-border px-4 py-3"
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

          <Text className="mb-2 mt-6 text-xs font-medium uppercase tracking-wide text-mutedForeground">
            Job tools
          </Text>
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
        </View>
      ) : null}
    </ScreenShell>
  );
}

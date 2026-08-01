import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { createJob } from '../api/jobs';
import { useListQuery } from '../hooks/useListQuery';
import { useApiClient } from '../lib/useApiClient';
import { jobRowText, type JobRow } from '../lib/jobRow';
import { PrimaryButton } from './Buttons';
import { ErrorState } from './ErrorState';

interface ServiceLocation {
  id: string;
  isPrimary?: boolean;
}

export interface JobPickerProps {
  /** Customer whose jobs to list; null until a customer is chosen. */
  customerId: string | null;
  /** Currently selected job id (controlled). */
  selectedJobId: string;
  onSelect: (jobId: string) => void;
}

/**
 * Shared job-selection step for estimate/invoice create flows. Lists the
 * chosen customer's jobs (GET /api/jobs?customerId=) and, when there are none
 * (or the user wants a fresh one), creates a job for that customer before
 * returning its id. Estimate/invoice creation requires a jobId (createEstimate
 * / createInvoiceSchema), so this guarantees one exists before submit.
 */
export function JobPicker({ customerId, selectedJobId, onSelect }: JobPickerProps) {
  const api = useApiClient();
  const params = useMemo<Record<string, string>>(
    () => (customerId ? { customerId } : ({} as Record<string, string>)),
    [customerId],
  );
  const { data: jobs, isLoading, error, refetch } = useListQuery<JobRow>('/api/jobs', {
    enabled: Boolean(customerId),
    params,
  });

  const [creating, setCreating] = useState(false);
  const [summary, setSummary] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const onCreateJob = async () => {
    if (!customerId || summary.trim().length === 0 || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const locRes = await api(`/api/locations?customerId=${encodeURIComponent(customerId)}`);
      if (!locRes.ok) throw new Error('Could not load customer locations');
      const locBody = (await locRes.json()) as ServiceLocation[] | { data?: ServiceLocation[] };
      const locations = Array.isArray(locBody) ? locBody : (locBody.data ?? []);
      const locationId = locations.find((l) => l.isPrimary)?.id ?? locations[0]?.id;
      if (!locationId) {
        throw new Error('This customer needs a service location before you can create a job.');
      }
      const result = await createJob(api, { customerId, locationId, summary: summary.trim() });
      setShowCreate(false);
      setSummary('');
      await refetch();
      onSelect(result.id);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : 'Could not create job');
    } finally {
      setCreating(false);
    }
  };

  if (!customerId) {
    return <Text className="text-base text-mutedForeground">Pick a customer first.</Text>;
  }

  return (
    <View>
      <Text className="mb-2 text-base font-medium text-foreground">Pick a job</Text>
      {isLoading ? <ActivityIndicator /> : null}
      {error ? (
        <ErrorState error={error} showRetry onRetry={() => void refetch()} className="mb-4" />
      ) : null}

      {!isLoading && jobs.length === 0 ? (
        <Text className="mb-2 text-base text-mutedForeground">
          No jobs for this customer yet. Create one to continue.
        </Text>
      ) : null}

      {jobs.map((j) => {
        const row = jobRowText(j);
        const selected = j.id === selectedJobId;
        return (
          <Pressable
            key={j.id}
            accessibilityRole="button"
            onPress={() => onSelect(j.id)}
            className={`mb-2 min-h-11 rounded-md border px-4 py-3 ${
              selected ? 'border-primary bg-primary/10' : 'border-border bg-card'
            }`}
          >
            <Text className="text-base text-foreground">{row.primary}</Text>
            {row.secondary ? (
              <Text className="text-sm text-mutedForeground">{row.secondary}</Text>
            ) : null}
          </Pressable>
        );
      })}

      {showCreate ? (
        <View className="mt-2 rounded-md border border-border bg-card p-4">
          <Text className="mb-1 text-sm text-mutedForeground">New job summary</Text>
          <TextInput
            className="min-h-11 rounded-md border border-border px-4 py-2 text-base text-foreground"
            value={summary}
            onChangeText={setSummary}
            placeholder="What needs to be done?"
            multiline
          />
          {createError ? (
            <Text className="mt-2 text-sm text-destructive">{createError}</Text>
          ) : null}
          <PrimaryButton
            label="Create job"
            loading={creating}
            disabled={summary.trim().length === 0 || creating}
            onPress={() => void onCreateJob()}
            className="mt-3"
          />
        </View>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Create a job for this customer"
          onPress={() => setShowCreate(true)}
          className="mt-2 min-h-11 items-center justify-center rounded-md border border-dashed border-border px-4 py-3"
        >
          <Text className="text-base font-medium text-primary">+ Create a job for this customer</Text>
        </Pressable>
      )}
    </View>
  );
}

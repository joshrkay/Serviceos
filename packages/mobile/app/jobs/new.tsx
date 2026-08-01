import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { createJob } from '../../src/api/jobs';
import { ErrorState } from '../../src/components/ErrorState';
import { ScreenShell } from '../../src/components/ScreenShell';
import { SavePhaseButton } from '../../src/components/SavePhaseButton';
import { useListQuery } from '../../src/hooks/useListQuery';
import { useSavePhase } from '../../src/hooks/useSavePhase';
import { useApiClient } from '../../src/lib/useApiClient';

interface Customer {
  id: string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
}

interface ServiceLocation {
  id: string;
  isPrimary?: boolean;
  street1?: string;
  city?: string;
}

function customerName(c: Customer): string {
  return c.displayName || [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Unnamed customer';
}

export default function NewJob() {
  const router = useRouter();
  const api = useApiClient();
  const { data: customers, isLoading, error, refetch } = useListQuery<Customer>('/api/customers');
  const { phase, error: saveError, run } = useSavePhase();
  const [customerId, setCustomerId] = useState('');
  const [summary, setSummary] = useState('');
  const [locationError, setLocationError] = useState<string | null>(null);

  const selectedCustomer = useMemo(
    () => customers.find((c) => c.id === customerId),
    [customers, customerId],
  );

  const canSave = customerId.length > 0 && summary.trim().length > 0;

  const onSave = () => {
    if (!canSave) return;
    setLocationError(null);
    void run(async () => {
      const locRes = await api(`/api/locations?customerId=${encodeURIComponent(customerId)}`);
      if (!locRes.ok) throw new Error('Could not load customer locations');
      const locBody = (await locRes.json()) as ServiceLocation[] | { data?: ServiceLocation[] };
      const locations = Array.isArray(locBody) ? locBody : (locBody.data ?? []);
      const locationId =
        locations.find((l) => l.isPrimary)?.id ?? locations[0]?.id;
      if (!locationId) {
        setLocationError('This customer needs a service location before you can create a job.');
        throw new Error('No service location on file');
      }
      const result = await createJob(api, {
        customerId,
        locationId,
        summary: summary.trim(),
      });
      router.replace(`/jobs/${result.id}`);
    });
  };

  return (
    <ScreenShell title="New job" backLabel="‹ Jobs">
      {isLoading ? <ActivityIndicator /> : null}
      {error ? <ErrorState error={error} showRetry onRetry={() => void refetch()} className="mb-4" /> : null}

      <View className="gap-4">
        <View>
          <Text className="mb-2 text-sm font-medium text-mutedForeground">Customer</Text>
          {customers.length === 0 && !isLoading ? (
            <Text className="text-base text-mutedForeground">Add a customer first.</Text>
          ) : null}
          {customers.map((c) => {
            const selected = c.id === customerId;
            return (
              <Pressable
                key={c.id}
                accessibilityRole="button"
                onPress={() => setCustomerId(c.id)}
                className={`mb-2 min-h-11 rounded-md border px-4 py-3 ${
                  selected ? 'border-primary bg-primary/10' : 'border-border bg-card'
                }`}
              >
                <Text className="text-base text-foreground">{customerName(c)}</Text>
              </Pressable>
            );
          })}
        </View>

        {selectedCustomer ? (
          <View>
            <Text className="mb-1 text-sm text-mutedForeground">Summary</Text>
            <TextInput
              className="min-h-11 rounded-md border border-border px-4 py-2 text-base text-foreground"
              value={summary}
              onChangeText={setSummary}
              placeholder="What needs to be done?"
              multiline
            />
          </View>
        ) : null}

        {locationError ? (
          <Text className="text-sm text-destructive">{locationError}</Text>
        ) : null}

        <SavePhaseButton
          phase={phase}
          error={saveError}
          idleLabel="Create job"
          savingLabel="Creating…"
          savedLabel="Created"
          onPress={onSave}
          disabled={!canSave}
        />
      </View>
    </ScreenShell>
  );
}

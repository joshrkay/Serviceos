import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { createEstimate, sendEstimate } from '../../src/api/estimates';
import { PrimaryButton, SecondaryButton } from '../../src/components/Buttons';
import { JobPicker } from '../../src/components/JobPicker';
import {
  LineItemList,
  LineItemSheet,
  type LineItem,
} from '../../src/components/LineItemSheet';
import { ScreenShell } from '../../src/components/ScreenShell';
import { SavePhaseButton } from '../../src/components/SavePhaseButton';
import { useListQuery } from '../../src/hooks/useListQuery';
import { useSavePhase } from '../../src/hooks/useSavePhase';
import { formatMoneyCents } from '../../src/lib/format';
import { useApiClient } from '../../src/lib/useApiClient';

interface Customer {
  id: string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
}

function customerName(c: Customer): string {
  return c.displayName || [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Unnamed customer';
}

function lineTotal(items: LineItem[]): number {
  return items.reduce((sum, li) => sum + li.quantity * li.unitPriceCents, 0);
}

export default function NewEstimate() {
  const router = useRouter();
  const api = useApiClient();
  const params = useLocalSearchParams<{ customerId?: string }>();
  const preCustomerId = Array.isArray(params.customerId) ? params.customerId[0] : params.customerId;
  const { data: customers } = useListQuery<Customer>('/api/customers');
  const { phase, error, run } = useSavePhase();
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [customerId, setCustomerId] = useState(preCustomerId ?? '');
  const [jobId, setJobId] = useState('');
  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [sheetOpen, setSheetOpen] = useState(false);

  const selectedCustomer = useMemo(
    () => customers.find((c) => c.id === customerId),
    [customers, customerId],
  );
  const totalCents = lineTotal(lineItems);

  const onCreateAndSend = () => {
    if (!jobId || lineItems.length === 0) return;
    void run(async () => {
      const { id } = await createEstimate(api, { jobId, lineItems });
      await sendEstimate(api, id);
      router.replace('/estimates');
    });
  };

  return (
    <ScreenShell title="New estimate" backLabel="‹ Estimates">
      <Text className="mb-4 text-sm text-mutedForeground">Step {step} of 4</Text>

      {step === 1 ? (
        <View>
          <Text className="mb-2 text-base font-medium text-foreground">Pick a customer</Text>
          {customers.map((c) => (
            <Pressable
              key={c.id}
              accessibilityRole="button"
              onPress={() => {
                if (c.id !== customerId) setJobId('');
                setCustomerId(c.id);
              }}
              className={`mb-2 min-h-11 rounded-md border px-4 py-3 ${
                customerId === c.id ? 'border-primary bg-primary/10' : 'border-border bg-card'
              }`}
            >
              <Text className="text-base text-foreground">{customerName(c)}</Text>
            </Pressable>
          ))}
          <PrimaryButton
            label="Next: job"
            onPress={() => setStep(2)}
            disabled={!customerId}
            className="mt-4"
          />
        </View>
      ) : null}

      {step === 2 ? (
        <View>
          <JobPicker customerId={customerId || null} selectedJobId={jobId} onSelect={setJobId} />
          <View className="mt-4 flex-row gap-2">
            <SecondaryButton label="Back" onPress={() => setStep(1)} className="flex-1" />
            <PrimaryButton
              label="Next: line items"
              onPress={() => setStep(3)}
              disabled={!jobId}
              className="flex-1"
            />
          </View>
        </View>
      ) : null}

      {step === 3 ? (
        <View>
          <Text className="mb-2 text-base font-medium text-foreground">Line items</Text>
          <LineItemList
            items={lineItems}
            onRemove={(index) => setLineItems((items) => items.filter((_, i) => i !== index))}
          />
          <PrimaryButton label="Add line item" onPress={() => setSheetOpen(true)} className="mt-4" />
          <View className="mt-4 flex-row gap-2">
            <SecondaryButton label="Back" onPress={() => setStep(2)} className="flex-1" />
            <PrimaryButton
              label="Review"
              onPress={() => setStep(4)}
              disabled={lineItems.length === 0}
              className="flex-1"
            />
          </View>
        </View>
      ) : null}

      {step === 4 ? (
        <View>
          <Text className="mb-2 text-base font-medium text-foreground">Review</Text>
          <Text className="text-base text-mutedForeground">
            Customer: {selectedCustomer ? customerName(selectedCustomer) : '—'}
          </Text>
          <Text className="mt-2 text-base text-mutedForeground">
            {lineItems.length} line item{lineItems.length === 1 ? '' : 's'} · {formatMoneyCents(totalCents)}
          </Text>
          <View className="mt-4 flex-row gap-2">
            <SecondaryButton label="Back" onPress={() => setStep(3)} className="flex-1" />
            <View className="flex-1">
              <SavePhaseButton
                phase={phase}
                error={error}
                idleLabel="Create & send"
                savingLabel="Sending…"
                savedLabel="Sent"
                onPress={onCreateAndSend}
                disabled={!jobId || lineItems.length === 0}
              />
            </View>
          </View>
        </View>
      ) : null}

      <LineItemSheet
        visible={sheetOpen}
        onClose={() => setSheetOpen(false)}
        onAdd={(item) => setLineItems((items) => [...items, item])}
      />
    </ScreenShell>
  );
}

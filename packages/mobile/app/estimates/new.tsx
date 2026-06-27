import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import {
  createEstimate,
  getEstimate,
  sendEstimate,
  updateEstimate,
} from '../../src/api/estimates';
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

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default function NewEstimate() {
  const router = useRouter();
  const api = useApiClient();
  const params = useLocalSearchParams<{ customerId?: string; id?: string; estimateId?: string }>();
  const preCustomerId = firstParam(params.customerId);
  // Editing an existing draft: the list passes the estimate id so we hydrate
  // the wizard and save via update (PATCH) instead of creating a duplicate.
  const editId = firstParam(params.id) ?? firstParam(params.estimateId) ?? '';
  const { data: customers } = useListQuery<Customer>('/api/customers');
  const { phase, error, run } = useSavePhase();
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [customerId, setCustomerId] = useState(preCustomerId ?? '');
  const [jobId, setJobId] = useState('');
  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [sheetOpen, setSheetOpen] = useState(false);
  // Optimistic-lock version of the estimate being edited; threaded back into
  // updateEstimate so a stale write is rejected by the server.
  const [expectedVersion, setExpectedVersion] = useState<number | null>(null);
  const [discountCents, setDiscountCents] = useState<number | undefined>(undefined);
  const [taxRateBps, setTaxRateBps] = useState<number | undefined>(undefined);
  const [customerMessage, setCustomerMessage] = useState<string | undefined>(undefined);
  const [hydrating, setHydrating] = useState(Boolean(editId));
  const [hydrateError, setHydrateError] = useState<string | null>(null);

  // Hydrate the wizard from an existing draft. The estimate response carries
  // `jobId` and `totals` but NOT a `customerId` (estimates reference the job,
  // which owns the customer), so resolve the customer from `estimate.customer`
  // when present, otherwise from a job → customer lookup. Money stays integer
  // cents — unitPriceCents/discountCents round-trip without any float math.
  useEffect(() => {
    if (!editId) return;
    let cancelled = false;
    setHydrating(true);
    setHydrateError(null);
    void (async () => {
      try {
        const est = await getEstimate(api, editId);
        let resolvedCustomerId = est.customer?.id ?? '';
        if (!resolvedCustomerId && est.jobId) {
          const jobRes = await api(`/api/jobs/${est.jobId}`);
          if (jobRes.ok) {
            const job = (await jobRes.json()) as { customerId?: string };
            resolvedCustomerId = job.customerId ?? '';
          }
        }
        if (cancelled) return;
        setCustomerId(resolvedCustomerId);
        setJobId(est.jobId ?? '');
        setLineItems(
          (est.lineItems ?? []).map((li) => ({
            catalogItemId: li.catalogItemId,
            description: li.description,
            quantity: li.quantity,
            unitPriceCents: li.unitPriceCents,
          })),
        );
        setDiscountCents(est.totals?.discountCents);
        setTaxRateBps(est.totals?.taxRateBps);
        setCustomerMessage(est.customerMessage);
        setExpectedVersion(est.version);
        // Drop the editor straight into the line-item step — customer/job are
        // already chosen on a draft, so the early steps are read-only context.
        setStep(3);
      } catch (e) {
        if (!cancelled) setHydrateError(e instanceof Error ? e.message : 'Failed to load draft');
      } finally {
        if (!cancelled) setHydrating(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [editId, api]);

  const selectedCustomer = useMemo(
    () => customers.find((c) => c.id === customerId),
    [customers, customerId],
  );
  const totalCents = lineTotal(lineItems);

  const onCreateAndSend = () => {
    if (!jobId || lineItems.length === 0) return;
    void run(async () => {
      if (editId) {
        // Editing an existing draft: update in place (not a new estimate),
        // threading the optimistic-lock version. A server-side edit lock
        // (deposit paid / accepted) surfaces as the thrown error message.
        await updateEstimate(api, editId, {
          lineItems,
          discountCents,
          taxRateBps,
          customerMessage,
          expectedVersion: expectedVersion ?? 0,
        });
        router.replace('/estimates');
        return;
      }
      const { id } = await createEstimate(api, {
        jobId,
        lineItems,
        discountCents,
        taxRateBps,
        customerMessage,
      });
      await sendEstimate(api, id);
      router.replace('/estimates');
    });
  };

  if (hydrating) {
    return (
      <ScreenShell title="Edit estimate" backLabel="‹ Estimates">
        <ActivityIndicator />
      </ScreenShell>
    );
  }

  return (
    <ScreenShell title={editId ? 'Edit estimate' : 'New estimate'} backLabel="‹ Estimates">
      {hydrateError ? (
        <Text className="mb-4 text-sm text-destructive">{hydrateError}</Text>
      ) : null}
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
                idleLabel={editId ? 'Save changes' : 'Create & send'}
                savingLabel={editId ? 'Saving…' : 'Sending…'}
                savedLabel={editId ? 'Saved' : 'Sent'}
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

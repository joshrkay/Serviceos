import { useEffect, useState } from 'react';
import { Modal, Pressable, Text, TextInput, View } from 'react-native';
import { recordInvoicePayment, type InvoicePaymentMethod } from '../api/invoices';
import type { AuthedFetch } from '../api/me';
import { useSavePhase } from '../hooks/useSavePhase';
import { formatMoneyCents } from '../lib/format';
import { parseDollarsToCents } from '../lib/money';
import { SecondaryButton } from './Buttons';
import { SavePhaseButton } from './SavePhaseButton';

const METHODS: { value: InvoicePaymentMethod; label: string }[] = [
  { value: 'cash', label: 'Cash' },
  { value: 'check', label: 'Check' },
  { value: 'credit_card', label: 'Card' },
  { value: 'bank_transfer', label: 'Bank' },
  { value: 'other', label: 'Other' },
];

export interface RecordPaymentSheetProps {
  visible: boolean;
  onClose: () => void;
  client: AuthedFetch;
  invoiceId: string;
  /** Outstanding balance in integer cents — pre-fills the amount and caps it. */
  amountDueCents: number;
  onRecorded?: () => void;
}

/**
 * Manual payment capture — cash / check / card / bank / other. The operator
 * types dollars; `parseDollarsToCents` converts once at the edge so the request
 * (and everything after it) is integer cents. The amount defaults to the full
 * balance and can't exceed it — the same cap the server enforces, surfaced
 * before the round-trip. A server rejection (wrong status, over-balance) shows
 * its message verbatim via the save phase.
 */
export function RecordPaymentSheet({
  visible,
  onClose,
  client,
  invoiceId,
  amountDueCents,
  onRecorded,
}: RecordPaymentSheetProps) {
  const { phase, error, run, reset } = useSavePhase();
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<InvoicePaymentMethod>('cash');

  // The sheet stays mounted across opens (the parent toggles `visible`), so a
  // prior 'saved' phase would otherwise linger and leave the button disabled on
  // reopen — e.g. recording a second partial payment. Reset on each open.
  useEffect(() => {
    if (visible) reset();
  }, [visible, reset]);

  const enteredCents = parseDollarsToCents(amount);
  const overpay = enteredCents !== null && enteredCents > amountDueCents;
  const valid = enteredCents !== null && enteredCents > 0 && !overpay;

  const close = () => {
    reset();
    setAmount('');
    setMethod('cash');
    onClose();
  };

  const submit = () => {
    if (enteredCents === null) return;
    void run(async () => {
      await recordInvoicePayment(client, invoiceId, { amountCents: enteredCents, method });
      onRecorded?.();
      close();
    });
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={close}>
      <View className="flex-1 bg-background px-6 pt-16">
        <Text className="font-heading text-2xl font-semibold text-foreground">Record payment</Text>
        <Text className="mt-1 text-base text-mutedForeground">
          {formatMoneyCents(amountDueCents)} outstanding
        </Text>

        <Text className="mb-2 mt-6 text-base font-medium text-foreground">Amount</Text>
        <TextInput
          accessibilityLabel="Payment amount in dollars"
          className="min-h-11 rounded-md border border-border px-4 py-3 text-base text-foreground"
          placeholder={formatMoneyCents(amountDueCents)}
          placeholderTextColor="#94a3b8"
          keyboardType="decimal-pad"
          value={amount}
          onChangeText={setAmount}
        />
        {overpay ? (
          <Text className="mt-2 text-sm text-destructive">
            Can&apos;t exceed the {formatMoneyCents(amountDueCents)} balance.
          </Text>
        ) : null}

        <Text className="mb-2 mt-6 text-base font-medium text-foreground">Method</Text>
        <View className="flex-row flex-wrap gap-2">
          {METHODS.map((m) => {
            const active = method === m.value;
            return (
              <Pressable
                key={m.value}
                accessibilityRole="button"
                accessibilityLabel={`Method: ${m.label}`}
                onPress={() => setMethod(m.value)}
                className={`min-h-11 items-center justify-center rounded-md border px-4 py-3 ${
                  active ? 'border-primary bg-primary/10' : 'border-border bg-card'
                }`}
              >
                <Text className="text-base text-foreground">{m.label}</Text>
              </Pressable>
            );
          })}
        </View>

        <View className="mt-8">
          <SavePhaseButton
            phase={phase}
            error={error}
            idleLabel="Record payment"
            savingLabel="Recording…"
            savedLabel="Recorded"
            onPress={submit}
            disabled={!valid}
          />
        </View>
        <SecondaryButton label="Cancel" onPress={close} className="mt-3" />
      </View>
    </Modal>
  );
}

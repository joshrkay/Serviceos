import { useEffect, useState } from 'react';
import { Modal, ScrollView, Text, TextInput, View } from 'react-native';
import { convertLead, type ConvertLeadAddress } from '../api/leads';
import type { AuthedFetch } from '../api/me';
import { useSavePhase } from '../hooks/useSavePhase';
import { SecondaryButton } from './Buttons';
import { SavePhaseButton } from './SavePhaseButton';

export interface ConvertLeadSheetProps {
  visible: boolean;
  onClose: () => void;
  client: AuthedFetch;
  leadId: string;
  /** Any address the lead already has on file — pre-fills the form. */
  initial?: Partial<ConvertLeadAddress>;
  onConverted: (customerId: string) => void;
}

/**
 * Address capture for converting a lead. A service location is required to
 * create the customer (the server 400s `SERVICE_LOCATION_REQUIRED` without
 * one), so this collects street/city/state/postal before converting. Shown only
 * when the lead's own address is incomplete; a complete lead converts directly.
 */
export function ConvertLeadSheet({
  visible,
  onClose,
  client,
  leadId,
  initial,
  onConverted,
}: ConvertLeadSheetProps) {
  const { phase, error, run, reset } = useSavePhase();

  // Clear a stale save phase each time the sheet reopens (it stays mounted; the
  // parent toggles `visible`), so a prior error/saved state doesn't persist.
  useEffect(() => {
    if (visible) reset();
  }, [visible, reset]);

  const [street1, setStreet1] = useState(initial?.street1 ?? '');
  const [street2, setStreet2] = useState(initial?.street2 ?? '');
  const [city, setCity] = useState(initial?.city ?? '');
  const [state, setState] = useState(initial?.state ?? '');
  const [postalCode, setPostalCode] = useState(initial?.postalCode ?? '');

  const valid = street1.trim() && city.trim() && state.trim() && postalCode.trim();

  const close = () => {
    reset();
    onClose();
  };

  const submit = () => {
    if (!valid) return;
    void run(async () => {
      const { customerId } = await convertLead(client, leadId, {
        street1: street1.trim(),
        street2: street2.trim() || undefined,
        city: city.trim(),
        state: state.trim(),
        postalCode: postalCode.trim(),
      });
      onConverted(customerId);
    });
  };

  const field = (
    label: string,
    value: string,
    onChangeText: (t: string) => void,
    required?: boolean,
  ) => (
    <View className="mb-3">
      <Text className="mb-1 text-sm text-mutedForeground">
        {label}
        {required ? ' *' : ''}
      </Text>
      <TextInput
        accessibilityLabel={label}
        className="min-h-11 rounded-md border border-border px-4 py-3 text-base text-foreground"
        value={value}
        onChangeText={onChangeText}
        placeholderTextColor="#94a3b8"
      />
    </View>
  );

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={close}>
      <ScrollView className="flex-1 bg-background" contentContainerStyle={{ padding: 24, paddingTop: 64 }}>
        <Text className="font-heading text-2xl font-semibold text-foreground">Service address</Text>
        <Text className="mt-1 text-base text-mutedForeground">
          A customer needs a service location. Add one to convert this lead.
        </Text>

        <View className="mt-6">
          {field('Street', street1, setStreet1, true)}
          {field('Street 2', street2, setStreet2)}
          {field('City', city, setCity, true)}
          {field('State', state, setState, true)}
          {field('Postal code', postalCode, setPostalCode, true)}
        </View>

        <View className="mt-4">
          <SavePhaseButton
            phase={phase}
            error={error}
            idleLabel="Convert to customer"
            savingLabel="Converting…"
            savedLabel="Converted"
            onPress={submit}
            disabled={!valid}
          />
        </View>
        <SecondaryButton label="Cancel" onPress={close} className="mt-3" />
      </ScrollView>
    </Modal>
  );
}

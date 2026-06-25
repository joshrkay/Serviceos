import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { createCustomer } from '../../src/api/customers';
import { ScreenShell } from '../../src/components/ScreenShell';
import { SavePhaseButton } from '../../src/components/SavePhaseButton';
import { useSavePhase } from '../../src/hooks/useSavePhase';
import { useApiClient } from '../../src/lib/useApiClient';

export default function NewCustomer() {
  const router = useRouter();
  const api = useApiClient();
  const { phase, error, run } = useSavePhase();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');

  const canSave = firstName.trim().length > 0 && lastName.trim().length > 0;

  const onSave = () => {
    if (!canSave) return;
    void run(async () => {
      const result = await createCustomer(api, {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        primaryPhone: phone.trim() || undefined,
        email: email.trim() || undefined,
      });
      router.replace(`/customers/${result.id}`);
    });
  };

  return (
    <ScreenShell title="New customer" backLabel="‹ Customers">
      <View className="gap-4">
        <View>
          <Text className="mb-1 text-sm text-mutedForeground">First name</Text>
          <TextInput
            className="min-h-11 rounded-md border border-border px-4 py-2 text-base text-foreground"
            value={firstName}
            onChangeText={setFirstName}
            autoCapitalize="words"
          />
        </View>
        <View>
          <Text className="mb-1 text-sm text-mutedForeground">Last name</Text>
          <TextInput
            className="min-h-11 rounded-md border border-border px-4 py-2 text-base text-foreground"
            value={lastName}
            onChangeText={setLastName}
            autoCapitalize="words"
          />
        </View>
        <View>
          <Text className="mb-1 text-sm text-mutedForeground">Phone</Text>
          <TextInput
            className="min-h-11 rounded-md border border-border px-4 py-2 text-base text-foreground"
            value={phone}
            onChangeText={setPhone}
            keyboardType="phone-pad"
            placeholder="+1 555 123 4567"
          />
        </View>
        <View>
          <Text className="mb-1 text-sm text-mutedForeground">Email</Text>
          <TextInput
            className="min-h-11 rounded-md border border-border px-4 py-2 text-base text-foreground"
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoCapitalize="none"
          />
        </View>
        <SavePhaseButton
          phase={phase}
          error={error}
          idleLabel="Create customer"
          savingLabel="Creating…"
          savedLabel="Created"
          onPress={onSave}
          disabled={!canSave}
        />
      </View>
    </ScreenShell>
  );
}

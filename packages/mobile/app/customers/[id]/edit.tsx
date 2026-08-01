import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Text, TextInput, View } from 'react-native';
import { updateCustomer } from '../../../src/api/customers';
import { ErrorState } from '../../../src/components/ErrorState';
import { ScreenShell } from '../../../src/components/ScreenShell';
import { SavePhaseButton } from '../../../src/components/SavePhaseButton';
import { useDetailQuery } from '../../../src/hooks/useDetailQuery';
import { useSavePhase } from '../../../src/hooks/useSavePhase';
import { useApiClient } from '../../../src/lib/useApiClient';

interface Customer {
  id: string;
  firstName?: string;
  lastName?: string;
  primaryPhone?: string;
  email?: string;
}

export default function EditCustomer() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = Array.isArray(params.id) ? params.id[0] : (params.id ?? '');
  const router = useRouter();
  const api = useApiClient();
  const { data, isLoading, error, refetch } = useDetailQuery<Customer>(
    id ? `/api/customers/${id}` : null,
  );
  const { phase, error: saveError, run } = useSavePhase();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');

  useEffect(() => {
    if (!data) return;
    setFirstName(data.firstName ?? '');
    setLastName(data.lastName ?? '');
    setPhone(data.primaryPhone ?? '');
    setEmail(data.email ?? '');
  }, [data]);

  const canSave = firstName.trim().length > 0 && lastName.trim().length > 0;

  const onSave = () => {
    if (!id || !canSave) return;
    void run(async () => {
      await updateCustomer(api, id, {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        primaryPhone: phone.trim() || undefined,
        email: email.trim() || undefined,
      });
      router.back();
    });
  };

  return (
    <ScreenShell title="Edit customer" backLabel="‹ Customer">
      {isLoading ? <ActivityIndicator /> : null}
      {error ? <ErrorState error={error} showRetry onRetry={() => void refetch()} className="mb-4" /> : null}
      {data ? (
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
            error={saveError}
            idleLabel="Save changes"
            savingLabel="Saving…"
            savedLabel="Saved"
            onPress={onSave}
            disabled={!canSave}
          />
        </View>
      ) : null}
    </ScreenShell>
  );
}

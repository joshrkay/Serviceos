import { type Href, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useMe } from '../../../src/hooks/useMe';
import { useSignOut } from '../../../src/push/useSignOut';
import { getCallbackNumber, saveCallbackNumber } from '../../../src/calls/callbackStorage';
import { ErrorState } from '../../../src/components/ErrorState';
import { PushDeniedNotice } from '../../../src/components/PushDeniedNotice';
import { NotificationPreferences } from '../../../src/components/NotificationPreferences';
import { LabelValueTable } from '../../../src/components/LabelValueTable';
import { PrimaryButton } from '../../../src/components/Buttons';

// U4 hygiene note: the former brand-voice / voice settings screens were
// unreachable placeholder stubs ("will be configurable here") — deleted per
// the CLAUDE.md dead-code rule rather than linked (admin stays web-first,
// D-021). The screens test pins their absence.
const LINKS: Array<{ label: string; route: Href; subtitle?: string }> = [
  { label: 'Team & roles', route: '/settings/team', subtitle: 'Invite and manage your crew' },
  { label: 'Message templates', route: '/settings/templates', subtitle: 'Reusable SMS replies' },
  { label: 'Weekly digest', route: '/digest', subtitle: 'Owner summary' },
  { label: 'End of day review', route: '/digest/end-of-day', subtitle: 'Close-out checklist' },
];

export default function SettingsHub() {
  const router = useRouter();
  const { me, isLoading, error, refetch } = useMe();
  const signOut = useSignOut();
  const [callback, setCallback] = useState('');
  const [callbackStatus, setCallbackStatus] = useState<'idle' | 'saved' | 'invalid'>('idle');

  useEffect(() => {
    void getCallbackNumber().then((n) => {
      if (n) setCallback(n);
    });
  }, []);

  const onSaveCallback = async () => {
    const stored = await saveCallbackNumber(callback);
    if (!stored) {
      setCallbackStatus('invalid');
      return;
    }
    setCallback(stored);
    setCallbackStatus('saved');
  };

  return (
    <ScrollView className="flex-1 bg-background" contentContainerStyle={{ paddingTop: 64, paddingBottom: 96 }}>
      <View className="px-6">
        <Text className="font-heading text-2xl font-semibold text-foreground">Settings</Text>
        <Text className="mt-1 text-base text-mutedForeground">Your business, team, and preferences</Text>
      </View>

      <View className="px-6 pt-4">
        {isLoading ? <ActivityIndicator /> : null}
        {error ? <ErrorState error={error} showRetry onRetry={() => void refetch()} className="mb-4" /> : null}
        <PushDeniedNotice className="mb-4" />

        <LabelValueTable
          rows={[
            { label: 'Role', value: me?.role },
            { label: 'Mode', value: me?.current_mode },
            { label: 'Field-capable', value: me ? (me.can_field_serve ? 'Yes' : 'No') : undefined },
          ]}
        />
        {/* U4 — mode is read-only here by design; the interactive toggle lives
            on Home (field-friendly, one screen from anywhere). */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Switch mode on Home"
          onPress={() => router.push('/')}
          className="mt-2 min-h-11 justify-center"
        >
          <Text className="text-sm text-primary">Switch mode on the Home screen →</Text>
        </Pressable>

        <Text className="mb-2 mt-8 text-xs font-medium uppercase tracking-wide text-mutedForeground">
          Configuration
        </Text>
        {LINKS.map((link) => (
          <Pressable
            key={link.label}
            accessibilityRole="button"
            onPress={() => router.push(link.route)}
            className="mb-2 min-h-11 rounded-lg border border-border bg-card px-4 py-3"
          >
            <Text className="text-base font-medium text-foreground">{link.label}</Text>
            {link.subtitle ? (
              <Text className="mt-0.5 text-sm text-mutedForeground">{link.subtitle}</Text>
            ) : null}
          </Pressable>
        ))}

        <Text className="mt-8 text-base font-medium text-foreground">Your callback number</Text>
        <Text className="mt-1 text-sm text-mutedForeground">
          We ring this phone first, then connect you to the customer.
        </Text>
        <TextInput
          className="mt-3 min-h-11 rounded-md border border-border px-4 py-2 text-base text-foreground"
          placeholder="+1 555 123 4567"
          keyboardType="phone-pad"
          value={callback}
          onChangeText={(t) => {
            setCallback(t);
            setCallbackStatus('idle');
          }}
        />
        {callbackStatus === 'invalid' ? (
          <Text className="mt-1 text-sm text-destructive">Enter a valid phone number.</Text>
        ) : null}
        {callbackStatus === 'saved' ? (
          <Text className="mt-1 text-sm text-success">Saved.</Text>
        ) : null}
        <PrimaryButton label="Save callback number" onPress={() => void onSaveCallback()} className="mt-3" />

        <NotificationPreferences className="mt-8" />

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Sign out"
          onPress={() => void signOut()}
          className="mt-8 min-h-11 items-center justify-center rounded-md border border-border px-4 py-3"
        >
          <Text className="text-base text-destructive">Sign out</Text>
        </Pressable>

        {/* Guideline 5.1.1(v) — account deletion must be reachable in-app. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Delete account"
          onPress={() => router.push('/settings/delete-account')}
          className="mt-3 min-h-11 items-center justify-center rounded-md px-4 py-3"
        >
          <Text className="text-sm text-mutedForeground">Delete account</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

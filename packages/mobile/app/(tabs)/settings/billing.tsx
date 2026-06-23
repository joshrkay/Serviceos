import { Text } from 'react-native';
import { SettingsSubPage } from '../../../src/components/SettingsSubPage';

export default function BillingSettings() {
  return (
    <SettingsSubPage title="Billing" subtitle="Subscription and payments">
      <Text className="text-base text-mutedForeground">
        Manage your AI Service OS subscription and payment method. Billing portal coming soon.
      </Text>
    </SettingsSubPage>
  );
}

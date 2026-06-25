import { ActivityIndicator, Text, View } from 'react-native';
import { SettingsSubPage } from '../../../src/components/SettingsSubPage';
import { ErrorState } from '../../../src/components/ErrorState';
import { useListQuery } from '../../../src/hooks/useListQuery';

interface MessageTemplate {
  id: string;
  name: string;
  category?: string;
  channel?: string;
}

export default function TemplatesSettings() {
  const { data, isLoading, error, refetch } = useListQuery<MessageTemplate>('/api/message-templates');

  return (
    <SettingsSubPage title="Message templates" subtitle="Reusable SMS replies">
      {isLoading ? <ActivityIndicator /> : null}
      {error ? <ErrorState error={error} showRetry onRetry={() => void refetch()} className="mb-4" /> : null}
      {!isLoading && !error && data.length === 0 ? (
        <Text className="text-base text-mutedForeground">No message templates yet.</Text>
      ) : null}
      {data.map((tpl) => (
        <View key={tpl.id} className="mb-2 min-h-11 rounded-lg border border-border bg-card px-4 py-3">
          <Text className="text-base font-medium text-foreground">{tpl.name}</Text>
          {tpl.category || tpl.channel ? (
            <Text className="mt-0.5 text-sm text-mutedForeground">
              {[tpl.category, tpl.channel].filter(Boolean).join(' · ')}
            </Text>
          ) : null}
        </View>
      ))}
    </SettingsSubPage>
  );
}

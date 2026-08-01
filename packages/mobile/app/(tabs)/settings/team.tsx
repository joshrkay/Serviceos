import { ActivityIndicator, Text, View } from 'react-native';
import { SettingsSubPage } from '../../../src/components/SettingsSubPage';
import { ErrorState } from '../../../src/components/ErrorState';
import { useListQuery } from '../../../src/hooks/useListQuery';

interface TeamUser {
  id: string;
  email: string;
  role: string;
  firstName?: string;
  lastName?: string;
}

function userName(u: TeamUser): string {
  const name = [u.firstName, u.lastName].filter(Boolean).join(' ');
  return name || u.email;
}

export default function TeamSettings() {
  const { data, isLoading, error, refetch } = useListQuery<TeamUser>('/api/users');

  return (
    <SettingsSubPage title="Team & roles" subtitle="Invite and manage your crew">
      {isLoading ? <ActivityIndicator /> : null}
      {error ? <ErrorState error={error} showRetry onRetry={() => void refetch()} className="mb-4" /> : null}
      {!isLoading && !error && data.length === 0 ? (
        <Text className="text-base text-mutedForeground">
          No team members yet. Invitations and role edits will appear here.
        </Text>
      ) : null}
      {data.map((user) => (
        <View key={user.id} className="mb-2 min-h-11 rounded-lg border border-border bg-card px-4 py-3">
          <Text className="text-base font-medium text-foreground">{userName(user)}</Text>
          <Text className="mt-0.5 text-sm capitalize text-mutedForeground">{user.role}</Text>
        </View>
      ))}
    </SettingsSubPage>
  );
}

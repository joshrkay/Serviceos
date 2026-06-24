import { useRouter } from 'expo-router';
import { Pressable, Text } from 'react-native';
import { EntityList } from '../../src/components/EntityList';
import { useListQuery } from '../../src/hooks/useListQuery';
import { jobRowText, type JobRow } from '../../src/lib/jobRow';

export default function Jobs() {
  const router = useRouter();
  const { data, isLoading, error, refetch } = useListQuery<JobRow>('/api/jobs');

  return (
    <EntityList
      title="Jobs"
      data={data}
      isLoading={isLoading}
      error={error}
      onRefresh={() => void refetch()}
      keyOf={(j) => j.id}
      renderRow={(j) => jobRowText(j)}
      onPressRow={(j) => router.push(`/jobs/${j.id}`)}
      emptyText="No jobs yet."
      showBack={false}
      headerAction={
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New job"
          onPress={() => router.push('/jobs/new')}
          className="min-h-11 justify-center px-2"
        >
          <Text className="text-base font-semibold text-primary">+ New</Text>
        </Pressable>
      }
    />
  );
}

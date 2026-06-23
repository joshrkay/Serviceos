import { DigestBody } from '../../src/components/DigestBody';
import { ScreenShell } from '../../src/components/ScreenShell';
import { useDigest } from '../../src/hooks/useDigest';

export default function WeeklyDigest() {
  const { data, isLoading, error, refetch } = useDigest('latest');

  return (
    <ScreenShell title="Weekly digest" backLabel="‹ Settings" subtitle="Owner summary">
      <DigestBody data={data} isLoading={isLoading} error={error} refetch={refetch} />
    </ScreenShell>
  );
}

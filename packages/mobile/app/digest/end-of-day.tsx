import { DigestBody } from '../../src/components/DigestBody';
import { ScreenShell } from '../../src/components/ScreenShell';
import { useDigest } from '../../src/hooks/useDigest';

export default function EndOfDayDigest() {
  const { data, isLoading, error, refetch } = useDigest('latest');

  return (
    <ScreenShell title="End of day review" backLabel="‹ Settings" subtitle="Close-out checklist">
      <DigestBody data={data} isLoading={isLoading} error={error} refetch={refetch} />
    </ScreenShell>
  );
}

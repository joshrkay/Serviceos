import { useParams, useSearchParams } from 'react-router';
import { JobsList } from './JobsList';
import { JobDetailView } from './JobDetail';
import { TechJobView } from './TechJobView';

export function JobsPage() {
  const { id }          = useParams<{ id: string }>();
  const [searchParams]  = useSearchParams();
  const viewMode        = searchParams.get('view');

  if (id && viewMode === 'tech') return <TechJobView id={id} />;
  if (id)                        return <JobDetailView id={id} />;
  return <JobsList />;
}

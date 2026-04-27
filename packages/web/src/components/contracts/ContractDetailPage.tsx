import { useParams } from 'react-router';

export function ContractDetailPage() {
  const { id } = useParams();

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto">
      <h1 className="text-slate-900">Contract Detail</h1>
      <p className="text-sm text-slate-500 mt-1">Contract ID: {id}</p>
    </div>
  );
}

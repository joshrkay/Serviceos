import { useParams } from 'react-router';

export function ContractDetailPage() {
  const { id } = useParams();

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto">
      <h1 className="text-slate-900">Contract Detail</h1>
      <p className="text-sm text-slate-500 mt-1">Contract ID: {id}</p>
import { useMemo } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ArrowLeft, PauseCircle, XCircle } from 'lucide-react';
import { useDetailQuery } from '../../hooks/useDetailQuery';
import { useListQuery } from '../../hooks/useListQuery';
import { useMutation } from '../../hooks/useMutation';

interface ApiContract {
  id: string;
  title: string;
  cadence?: string;
  status?: string;
  serviceWindow?: string;
  duration?: string;
  startDate?: string;
  endDate?: string;
}

interface ApiJob {
  id: string;
  jobNumber?: string;
  summary?: string;
  status?: string;
  scheduledStart?: string;
}

function formatDate(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString();
}

export function ContractDetailPage() {
  const { id } = useParams<{ id: string }>();

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto">
      <h1 className="text-slate-900">Contract Detail</h1>
      <p className="text-sm text-slate-500 mt-1">Contract ID: {id ?? 'Unknown'}</p>
    </div>
  );
}

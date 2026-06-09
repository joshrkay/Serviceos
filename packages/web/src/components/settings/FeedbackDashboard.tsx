import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { ChevronLeft, Star, MessageSquare } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '../ui/chart';
import { Spinner, EmptyState } from '../ui';
import { ErrorState } from '../ErrorState';
import { apiFetch } from '../../utils/api-fetch';

type FeedbackResponse = {
  id: string;
  rating: number;
  comment: string | null;
  submittedAt: string;
};

type ListResponse = {
  responses: FeedbackResponse[];
  total: number;
};

const chartConfig = {
  count: { label: 'Responses', color: '#f59e0b' },
} satisfies ChartConfig;

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffMs = then - now;
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (Math.abs(diffDays) >= 1) return rtf.format(diffDays, 'day');
  const diffHours = Math.round(diffMs / (1000 * 60 * 60));
  if (Math.abs(diffHours) >= 1) return rtf.format(diffHours, 'hour');
  const diffMinutes = Math.round(diffMs / (1000 * 60));
  return rtf.format(diffMinutes, 'minute');
}

export function FeedbackDashboard() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [responses, setResponses] = useState<FeedbackResponse[]>([]);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/feedback/responses?limit=50&offset=0');
        if (!res.ok) {
          if (!cancelled) {
            setError('Could not load feedback.');
            setLoading(false);
          }
          return;
        }
        const data: ListResponse = await res.json();
        if (cancelled) return;
        setResponses(data.responses);
        setTotal(data.total);
        setLoading(false);
      } catch {
        if (!cancelled) {
          setError('Network error.');
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const avgRating = useMemo(() => {
    if (responses.length === 0) return 0;
    const sum = responses.reduce((s, r) => s + r.rating, 0);
    return sum / responses.length;
  }, [responses]);

  const buckets = useMemo(
    () => [1, 2, 3, 4, 5].map(star => ({
      star: `${star}★`,
      count: responses.filter(r => r.rating === star).length,
    })),
    [responses],
  );

  const commented = useMemo(
    () => responses.filter(r => r.comment && r.comment.trim().length > 0),
    [responses],
  );

  return (
    <div className="h-full overflow-y-auto pb-20 md:pb-0" style={{ scrollbarWidth: 'thin' }}>
      <div className="p-4 md:p-6 max-w-3xl mx-auto">
        <button
          onClick={() => navigate('/settings')}
          className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800 mb-4"
        >
          <ChevronLeft size={16} /> Settings
        </button>

        <h1 className="text-slate-900 mb-1">Feedback &amp; Reviews</h1>
        <p className="text-sm text-slate-500 mb-6">Customer ratings and comments from recent jobs.</p>

        {loading && (
          <div className="flex items-center justify-center py-12">
            <Spinner size="md" className="text-slate-900" label="Loading feedback" />
          </div>
        )}

        {!loading && error && (
          <ErrorState message={error} />
        )}

        {!loading && !error && total === 0 && (
          <EmptyState
            icon={<MessageSquare size={20} />}
            title="No feedback yet"
            description="Ratings and comments from customers will appear here."
          />
        )}

        {!loading && !error && total > 0 && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-5">
              <div className="rounded-2xl bg-white border border-slate-200 px-5 py-5">
                <p className="text-xs text-slate-400 mb-2">AVERAGE RATING</p>
                <div className="flex items-baseline gap-2">
                  <span data-testid="average-rating" className="text-4xl text-slate-900">
                    {avgRating.toFixed(1)}
                  </span>
                  <span className="text-sm text-slate-400">/ 5</span>
                </div>
                <div className="mt-2 flex items-center gap-0.5">
                  {[1, 2, 3, 4, 5].map(n => (
                    <Star
                      key={n}
                      size={16}
                      className={n <= Math.round(avgRating)
                        ? 'fill-amber-400 text-amber-400'
                        : 'fill-none text-slate-300'}
                    />
                  ))}
                  <span className="text-xs text-slate-400 ml-2">{total} {total === 1 ? 'response' : 'responses'}</span>
                </div>
              </div>

              <div className="rounded-2xl bg-white border border-slate-200 px-5 py-5">
                <p className="text-xs text-slate-400 mb-2">DISTRIBUTION</p>
                <ChartContainer config={chartConfig} className="h-[140px] aspect-auto w-full">
                  <BarChart data={buckets} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
                    <CartesianGrid vertical={false} strokeDasharray="3 3" />
                    <XAxis dataKey="star" tickLine={false} axisLine={false} fontSize={11} />
                    <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={11} width={30} />
                    <ChartTooltip content={<ChartTooltipContent hideLabel />} />
                    <Bar dataKey="count" fill="var(--color-count)" radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ChartContainer>
              </div>
            </div>

            <div className="rounded-2xl bg-white border border-slate-200 overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-100 flex items-center gap-2">
                <MessageSquare size={14} className="text-slate-500" />
                <p className="text-sm text-slate-800">Recent comments</p>
                <span className="text-xs text-slate-400">{commented.length}</span>
              </div>
              {commented.length === 0 ? (
                <p className="px-5 py-6 text-sm text-slate-400 text-center">No written comments yet.</p>
              ) : (
                <ul className="max-h-[420px] overflow-y-auto divide-y divide-slate-100">
                  {commented.map(r => (
                    <li key={r.id} className="px-5 py-3">
                      <div className="flex items-center justify-between gap-3 mb-1">
                        <div className="flex items-center gap-0.5">
                          {[1, 2, 3, 4, 5].map(n => (
                            <Star
                              key={n}
                              size={12}
                              className={n <= r.rating
                                ? 'fill-amber-400 text-amber-400'
                                : 'fill-none text-slate-300'}
                            />
                          ))}
                        </div>
                        <span className="text-xs text-slate-400">{formatRelative(r.submittedAt)}</span>
                      </div>
                      <p className="text-sm text-slate-700">{r.comment}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

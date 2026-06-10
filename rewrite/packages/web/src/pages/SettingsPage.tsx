import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import type { TenantSettings } from '@rivet/contracts';
import { api } from '../lib/api';

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: async () => {
      const result = await api.settings.get();
      if (result.status !== 200) throw new Error('failed');
      return result.body;
    },
  });

  const [form, setForm] = useState<TenantSettings | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (settings.data && !form) setForm(settings.data);
  }, [settings.data, form]);

  const save = useMutation({
    mutationFn: (body: TenantSettings) => api.settings.update({ body }),
    onSuccess: () => {
      setSaved(true);
      setTimeout(() => setSaved(false), 2_000);
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      void queryClient.invalidateQueries({ queryKey: ['me'] });
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (form) save.mutate(form);
  }

  if (!form) return <div className="text-sm text-stone-500">Loading…</div>;

  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
      <form onSubmit={submit} className="mt-6 max-w-lg space-y-4 rounded-xl border border-stone-200 bg-white p-6 shadow-sm">
        <label className="block text-sm">
          Business name
          <input
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none"
          />
        </label>
        <label className="block text-sm">
          Business phone (Rivet answers this number)
          <input
            value={form.phone ?? ''}
            onChange={(event) => setForm({ ...form, phone: event.target.value || null })}
            className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none"
          />
        </label>
        <label className="block text-sm">
          Timezone
          <input
            value={form.timezone}
            onChange={(event) => setForm({ ...form, timezone: event.target.value })}
            className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none"
          />
        </label>
        <div className="grid grid-cols-2 gap-4">
          <label className="block text-sm">
            Default tax rate (bps)
            <input
              type="number"
              min={0}
              max={10000}
              value={form.defaultTaxRateBps}
              onChange={(event) => setForm({ ...form, defaultTaxRateBps: Number(event.target.value) })}
              className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none"
            />
          </label>
          <label className="block text-sm">
            AI daily quota
            <input
              type="number"
              min={0}
              value={form.aiDailyQuota}
              onChange={(event) => setForm({ ...form, aiDailyQuota: Number(event.target.value) })}
              className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none"
            />
          </label>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={save.isPending}
            className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-semibold text-white hover:bg-stone-700 disabled:opacity-50"
          >
            Save
          </button>
          {saved && <span className="text-sm text-emerald-600">Saved.</span>}
        </div>
      </form>
    </div>
  );
}

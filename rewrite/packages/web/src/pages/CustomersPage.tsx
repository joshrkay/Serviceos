import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../lib/api';

export default function CustomersPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [form, setForm] = useState({ name: '', phone: '' });
  const [error, setError] = useState<string | null>(null);

  const customers = useQuery({
    queryKey: ['customers', search],
    queryFn: async () => {
      const result = await api.customers.list({ query: search ? { search } : {} });
      if (result.status !== 200) throw new Error('failed');
      return result.body.customers;
    },
  });

  const create = useMutation({
    mutationFn: () => api.customers.create({ body: form }),
    onSuccess: (result) => {
      if (result.status === 201) {
        setForm({ name: '', phone: '' });
        setError(null);
        void queryClient.invalidateQueries({ queryKey: ['customers'] });
      } else {
        setError((result.body as { message?: string }).message ?? 'failed to create customer');
      }
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    create.mutate();
  }

  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight">Customers</h1>
      <div className="mt-6 flex items-start gap-6">
        <div className="flex-1">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by name or phone…"
            className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm focus:border-amber-500 focus:outline-none"
          />
          <div className="mt-4 overflow-hidden rounded-xl border border-stone-200 bg-white">
            {(customers.data ?? []).map((customer) => (
              <div key={customer.id} className="border-b border-stone-100 px-5 py-3 last:border-b-0">
                <div className="font-medium">{customer.name}</div>
                <div className="text-xs text-stone-500">
                  {customer.phone}
                  {customer.address ? ` · ${customer.address}` : ''}
                </div>
              </div>
            ))}
            {!customers.isLoading && (customers.data ?? []).length === 0 && (
              <div className="px-5 py-8 text-center text-sm text-stone-500">No customers found.</div>
            )}
          </div>
        </div>
        <form onSubmit={submit} className="w-72 rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">Add customer</h2>
          <label className="mt-4 block text-sm">
            Name
            <input
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none"
              required
            />
          </label>
          <label className="mt-3 block text-sm">
            Phone
            <input
              value={form.phone}
              onChange={(event) => setForm({ ...form, phone: event.target.value })}
              placeholder="+15551234567"
              className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none"
              required
            />
          </label>
          {error && <div className="mt-2 text-xs text-red-600">{error}</div>}
          <button
            type="submit"
            disabled={create.isPending}
            className="mt-4 w-full rounded-lg bg-stone-900 px-4 py-2 text-sm font-semibold text-white hover:bg-stone-700 disabled:opacity-50"
          >
            Add
          </button>
        </form>
      </div>
    </div>
  );
}

'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Search, Plus, Phone, X } from 'lucide-react';

interface Customer {
  id: string;
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  total_jobs: number;
  total_revenue: number;
}

export default function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', phone: '', email: '', address: '' });
  const [formError, setFormError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/customers')
      .then(r => r.json())
      .then(setCustomers)
      .finally(() => setLoading(false));
  }, []);

  const filtered = customers.filter(c =>
    c.name.toLowerCase().includes(search.toLowerCase()),
  );

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setFormError('');

    const res = await fetch('/api/customers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    });

    if (!res.ok) {
      const err = await res.json();
      setFormError(err.error || 'Failed to add');
      return;
    }

    const newCustomer = await res.json();
    setCustomers(prev => [...prev, newCustomer].sort((a, b) => a.name.localeCompare(b.name)));
    setShowForm(false);
    setForm({ name: '', phone: '', email: '', address: '' });
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="shrink-0 px-4 pt-4 pb-2 space-y-3">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold">Customers</h1>
          <button
            onClick={() => setShowForm(true)}
            className="size-8 flex items-center justify-center rounded-full bg-blue-600 text-white hover:bg-blue-700 transition-colors"
          >
            <Plus size={18} />
          </button>
        </div>
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search customers..."
            className="w-full rounded-lg border border-slate-200 bg-slate-50 pl-9 pr-3 py-2 text-sm outline-none focus:border-blue-400"
          />
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-4 pb-2">
        {loading ? (
          <p className="text-sm text-slate-400 text-center mt-8">Loading...</p>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-slate-400 text-center mt-8">
            {search ? 'No matches' : 'No customers yet'}
          </p>
        ) : (
          <div className="space-y-1">
            {filtered.map(c => (
              <Link
                key={c.id}
                href={`/customers/${c.id}`}
                className="flex items-center gap-3 p-3 rounded-xl hover:bg-slate-50 transition-colors"
              >
                <div className="size-9 shrink-0 rounded-full bg-slate-200 flex items-center justify-center text-sm font-medium text-slate-600">
                  {c.name.charAt(0)}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{c.name}</p>
                  {c.phone && (
                    <p className="text-xs text-slate-400 flex items-center gap-1">
                      <Phone size={10} /> {c.phone}
                    </p>
                  )}
                </div>
                <div className="text-right shrink-0">
                  <p className="text-xs text-slate-500">{c.total_jobs} jobs</p>
                  <p className="text-xs text-slate-400">
                    ${(c.total_revenue / 100).toLocaleString()}
                  </p>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Add customer modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center">
          <div className="bg-white w-full max-w-lg rounded-t-2xl sm:rounded-2xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">Add Customer</h2>
              <button onClick={() => setShowForm(false)}>
                <X size={20} className="text-slate-400" />
              </button>
            </div>
            <form onSubmit={handleAdd} className="space-y-3">
              <input
                required
                placeholder="Name *"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-blue-400"
              />
              <input
                placeholder="Phone"
                value={form.phone}
                onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-blue-400"
              />
              <input
                placeholder="Email"
                type="email"
                value={form.email}
                onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-blue-400"
              />
              <input
                placeholder="Address"
                value={form.address}
                onChange={e => setForm(f => ({ ...f, address: e.target.value }))}
                className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-blue-400"
              />
              {formError && <p className="text-sm text-red-600">{formError}</p>}
              <button
                type="submit"
                className="w-full rounded-lg bg-blue-600 text-white py-2.5 text-sm font-medium hover:bg-blue-700 transition-colors"
              >
                Add Customer
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

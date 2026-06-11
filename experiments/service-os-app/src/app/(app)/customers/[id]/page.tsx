'use client';

import { useState, useEffect, use } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Phone, Mail, MapPin, Pencil, Check, X } from 'lucide-react';

interface Customer {
  id: string;
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  total_jobs: number;
  total_revenue: number;
}

export default function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: '', phone: '', email: '', address: '' });

  useEffect(() => {
    fetch(`/api/customers/${id}`)
      .then(r => r.json())
      .then(c => {
        setCustomer(c);
        setForm({ name: c.name, phone: c.phone || '', email: c.email || '', address: c.address || '' });
      });
  }, [id]);

  async function handleSave() {
    const res = await fetch(`/api/customers/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    });
    if (res.ok) {
      const updated = await res.json();
      setCustomer(updated);
      setEditing(false);
    }
  }

  if (!customer) {
    return <div className="flex-1 flex items-center justify-center text-sm text-slate-400">Loading...</div>;
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 pt-4 pb-2">
        <button onClick={() => router.back()} className="text-slate-500 hover:text-slate-700">
          <ArrowLeft size={20} />
        </button>
        <h1 className="text-lg font-semibold flex-1">{customer.name}</h1>
        {!editing ? (
          <button onClick={() => setEditing(true)} className="text-blue-600 hover:text-blue-700">
            <Pencil size={18} />
          </button>
        ) : (
          <div className="flex gap-2">
            <button onClick={handleSave} className="text-green-600"><Check size={18} /></button>
            <button onClick={() => setEditing(false)} className="text-slate-400"><X size={18} /></button>
          </div>
        )}
      </div>

      <div className="px-4 space-y-4 pb-6">
        {/* Stats */}
        <div className="flex gap-3">
          <div className="flex-1 bg-white rounded-xl border border-slate-200 p-3 text-center">
            <p className="text-lg font-semibold">{customer.total_jobs}</p>
            <p className="text-xs text-slate-500">Jobs</p>
          </div>
          <div className="flex-1 bg-white rounded-xl border border-slate-200 p-3 text-center">
            <p className="text-lg font-semibold">${(customer.total_revenue / 100).toLocaleString()}</p>
            <p className="text-xs text-slate-500">Revenue</p>
          </div>
        </div>

        {/* Contact info */}
        <div className="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100">
          {editing ? (
            <div className="p-3 space-y-2">
              <input
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400"
                placeholder="Name"
              />
              <input
                value={form.phone}
                onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400"
                placeholder="Phone"
              />
              <input
                value={form.email}
                onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400"
                placeholder="Email"
              />
              <input
                value={form.address}
                onChange={e => setForm(f => ({ ...f, address: e.target.value }))}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400"
                placeholder="Address"
              />
            </div>
          ) : (
            <>
              {customer.phone && (
                <div className="flex items-center gap-3 p-3">
                  <Phone size={16} className="text-slate-400" />
                  <span className="text-sm">{customer.phone}</span>
                </div>
              )}
              {customer.email && (
                <div className="flex items-center gap-3 p-3">
                  <Mail size={16} className="text-slate-400" />
                  <span className="text-sm">{customer.email}</span>
                </div>
              )}
              {customer.address && (
                <div className="flex items-center gap-3 p-3">
                  <MapPin size={16} className="text-slate-400" />
                  <span className="text-sm">{customer.address}</span>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

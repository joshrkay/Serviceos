/**
 * Still uses Supabase directly: packages/api createInvoiceSchema requires jobId,
 * invoiceNumber, and lineItems — the mobile UI posts a simplified shape
 * (customer_id, amount_cents, description). Consolidate when a thin
 * “draft invoice” API exists on the Express service.
 */
import { NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase';
import { getTenantId } from '@/lib/tenant';

interface CreateInvoiceBody {
  customer_id?: string;
  amount_cents?: number;
  status?: 'draft' | 'sent' | 'paid' | 'overdue' | 'cancelled';
  description?: string;
  due_at?: string | null;
  job_id?: string | null;
}

export async function GET() {
  const tenantId = await getTenantId();
  if (!tenantId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createServerClient();

  const { data, error } = await supabase
    .from('invoices')
    .select('*, customers(name, phone, email, address)')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Supabase error listing invoices:', error.message);
    return NextResponse.json({ error: 'Failed to load invoices' }, { status: 500 });
  }

  return NextResponse.json(data);
}

export async function POST(req: Request) {
  const tenantId = await getTenantId();
  if (!tenantId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = (await req.json()) as CreateInvoiceBody;

  if (!body.customer_id) {
    return NextResponse.json({ error: 'Customer is required' }, { status: 400 });
  }

  const supabase = createServerClient();

  const { data: customer, error: customerErr } = await supabase
    .from('customers')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('id', body.customer_id)
    .single();

  if (customerErr || !customer) {
    return NextResponse.json({ error: 'Customer not found' }, { status: 404 });
  }

  const { data, error } = await supabase
    .from('invoices')
    .insert({
      tenant_id: tenantId,
      customer_id: body.customer_id,
      amount_cents: body.amount_cents ?? 0,
      status: body.status ?? 'draft',
      description: body.description ?? '',
      due_at: body.due_at ?? null,
      job_id: body.job_id ?? null,
    })
    .select('*, customers(name, phone, email, address)')
    .single();

  if (error) {
    console.error('Supabase error creating invoice:', error.message);
    return NextResponse.json({ error: 'Failed to create invoice' }, { status: 500 });
  }

  return NextResponse.json(data, { status: 201 });
}

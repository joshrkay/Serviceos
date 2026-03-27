import { NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase';
import { getTenantId } from '@/lib/tenant';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const tenantId = await getTenantId();
  if (!tenantId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const supabase = createServerClient();
  const { data, error } = await supabase
    .from('customers')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('id', id)
    .single();

  if (error || !data) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(data);
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const tenantId = await getTenantId();
  if (!tenantId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const body = await req.json();
  const { name, phone, email, address } = body;

  const supabase = createServerClient();
  const { data, error } = await supabase
    .from('customers')
    .update({ name, phone, email, address, updated_at: new Date().toISOString() })
    .eq('tenant_id', tenantId)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    console.error('Supabase error updating customer:', error.message);
    return NextResponse.json({ error: 'Failed to update customer' }, { status: 500 });
  }
  return NextResponse.json(data);
}

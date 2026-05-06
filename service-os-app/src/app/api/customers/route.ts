import { NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase';
import { getTenantId } from '@/lib/tenant';

export async function GET() {
  const tenantId = await getTenantId();
  if (!tenantId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createServerClient();
  const { data, error } = await supabase
    .from('customers')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('name');

  if (error) {
    console.error('Supabase error listing customers:', error.message);
    return NextResponse.json({ error: 'Failed to load customers' }, { status: 500 });
  }
  return NextResponse.json(data);
}

export async function POST(req: Request) {
  const tenantId = await getTenantId();
  if (!tenantId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const { name, phone, email, address } = body;

  if (!name) return NextResponse.json({ error: 'Name is required' }, { status: 400 });

  const supabase = createServerClient();

  // Duplicate phone check
  if (phone) {
    const { data: existing } = await supabase
      .from('customers')
      .select('id, name')
      .eq('tenant_id', tenantId)
      .eq('phone', phone)
      .single();

    if (existing) {
      return NextResponse.json(
        { error: `Phone already used by ${existing.name}`, duplicate: true },
        { status: 409 },
      );
    }
  }

  const { data, error } = await supabase
    .from('customers')
    .insert({ tenant_id: tenantId, name, phone, email, address })
    .select()
    .single();

  if (error) {
    console.error('Supabase error creating customer:', error.message);
    return NextResponse.json({ error: 'Failed to create customer' }, { status: 500 });
  }
  return NextResponse.json(data, { status: 201 });
}

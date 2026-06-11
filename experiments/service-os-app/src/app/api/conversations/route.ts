import { NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase';
import { getTenantId } from '@/lib/tenant';

export async function GET() {
  const tenantId = await getTenantId();
  if (!tenantId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createServerClient();
  const { data, error } = await supabase
    .from('conversations')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: true })
    .limit(100);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

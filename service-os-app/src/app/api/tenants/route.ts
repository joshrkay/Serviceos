import { auth, currentUser } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase';

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  const body = await req.json();
  const businessName = body.business_name || (user.unsafeMetadata as Record<string, string>)?.business_name || '';
  const tradeType = body.trade_type || (user.unsafeMetadata as Record<string, string>)?.trade_type || 'hvac';

  const supabase = createServerClient();

  // Check if tenant already exists
  const { data: existing } = await supabase
    .from('tenants')
    .select('id')
    .eq('clerk_user_id', userId)
    .single();

  if (existing) {
    return NextResponse.json({ id: existing.id });
  }

  const { data, error } = await supabase
    .from('tenants')
    .insert({
      clerk_user_id: userId,
      business_name: businessName,
      trade_type: tradeType,
      owner_name: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
      owner_email: user.emailAddresses[0]?.emailAddress || '',
    })
    .select('id')
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ id: data.id }, { status: 201 });
}

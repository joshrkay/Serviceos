import { currentUser } from '@clerk/nextjs/server';
import { createServerClient } from './supabase';

/** Get the tenant ID for the current Clerk user (server-side only). */
export async function getTenantId(): Promise<string | null> {
  const user = await currentUser();
  if (!user) return null;

  // Check Clerk metadata first (set during signup)
  const tenantId = (user.unsafeMetadata as Record<string, string>)?.tenant_id;
  if (tenantId) return tenantId;

  // Fallback: query Supabase
  const supabase = createServerClient();
  const { data } = await supabase
    .from('tenants')
    .select('id')
    .eq('clerk_user_id', user.id)
    .single();

  return data?.id ?? null;
}

import { createClient } from '@supabase/supabase-js';

// Client-side Supabase (uses anon key, respects RLS)
export function createBrowserClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error('Supabase URL or anonymous key is not set in environment variables.');
  }

  return createClient(url, anonKey);
}

// Server-side Supabase (uses service role key, bypasses RLS)
export function createServerClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error('Supabase URL or service role key is not set in environment variables.');
  }

  return createClient(url, serviceKey);
}

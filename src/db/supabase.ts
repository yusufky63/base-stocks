import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { serverEnv } from "@/config/env";

/**
 * Server-only Supabase admin client (secret / service-role key). Never imported by client code.
 * Returns null when Supabase is not configured so the app keeps working with in-memory storage.
 * All tables have RLS enabled with no public policies; only this server client can read/write.
 */
let client: SupabaseClient | null | undefined;

export function getSupabaseAdmin(): SupabaseClient | null {
  if (client !== undefined) return client;
  const env = serverEnv();
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    client = null;
    return client;
  }
  client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "x-application-name": "blocks" } },
  });
  return client;
}

export function isSupabaseConfigured(): boolean {
  return getSupabaseAdmin() !== null;
}

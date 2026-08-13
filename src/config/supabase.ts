import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import 'dotenv/config';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY!;
const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY!;

if (!supabaseUrl || !supabaseSecretKey || !supabasePublishableKey) {
  throw new Error('Missing Supabase environment variables. Check your .env file.');
}

// Full-access client — uses the SECRET key, bypasses RLS.
// Only ever use this on the server for trusted operations.
export const supabaseAdmin = createClient(supabaseUrl, supabaseSecretKey, {
  realtime: { transport: ws as any },
});

// Creates a client scoped to a specific logged-in user's token,
// so RLS policies apply based on who they actually are.
export function createUserClient(accessToken: string) {
  return createClient(supabaseUrl, supabasePublishableKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    realtime: { transport: ws as any },
  });
}
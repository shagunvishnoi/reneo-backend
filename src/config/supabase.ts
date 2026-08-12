import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY!;

if (!supabaseUrl || !supabaseSecretKey) {
  throw new Error('Missing Supabase environment variables. Check your .env file.');
}

// This client uses the SECRET key — full access, bypasses RLS.
// Only ever use this on the server, never send it to a browser.
export const supabaseAdmin = createClient(supabaseUrl, supabaseSecretKey);
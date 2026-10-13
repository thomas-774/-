// Public values: the Supabase project URL and its anon/publishable key.
// They are visible in the page by design — safety comes from database permissions (plan §4.2).
// NEVER put the service_role / secret key here.
//
// Set them here for production, or override per build with VITE_SUPABASE_URL /
// VITE_SUPABASE_ANON_KEY (e.g. in .env.local to point at the test project).
export const SUPABASE_URL: string =
  import.meta.env.VITE_SUPABASE_URL ?? 'https://zhawcnaqhriqgxjvxsaf.supabase.co';

export const SUPABASE_ANON_KEY: string =
  import.meta.env.VITE_SUPABASE_ANON_KEY ?? 'sb_publishable_Uax9orq9YJWpjcjKjZPG8A_K4-yJOlJ';

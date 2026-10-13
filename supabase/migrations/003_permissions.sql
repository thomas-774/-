-- 003_permissions.sql — the browser may only call the 4 public functions.
-- Postgres grants EXECUTE to PUBLIC by default, and Supabase's default privileges
-- also grant it to anon/authenticated, so every grant is revoked first.

-- Private schema: no access at all for API roles
revoke all on schema private from public, anon, authenticated;
revoke all on all tables    in schema private from public, anon, authenticated;
revoke all on all sequences in schema private from public, anon, authenticated;
revoke all on all functions in schema private from public, anon, authenticated;

alter default privileges in schema private revoke all on tables    from public, anon, authenticated;
alter default privileges in schema private revoke all on sequences from public, anon, authenticated;
alter default privileges in schema private revoke all on functions from public, anon, authenticated;

-- Public functions: revoke the defaults, then grant per role
revoke all on function public.register_member(text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.get_my_registration(text)                          from public, anon, authenticated;
revoke all on function public.admin_dashboard()                                  from public, anon, authenticated;
revoke all on function public.set_capacity(int)                                  from public, anon, authenticated;

grant execute on function public.register_member(text, text, text, text, text, text) to anon;
grant execute on function public.get_my_registration(text)                          to anon;
grant execute on function public.admin_dashboard()                                  to authenticated;
grant execute on function public.set_capacity(int)                                  to authenticated;

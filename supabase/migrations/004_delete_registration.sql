-- 004_delete_registration.sql — admin can delete a registration; a member can cancel their own.
-- Removing a confirmed row frees a seat: the first waiting row (by arrival) is promoted
-- with the next attendance number. Numbers are never reused, same as set_capacity.

-- Shared by both entry points. Caller must already hold the settings lock.
create or replace function private.remove_registration(p_id bigint)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_row       private.registrations;
  v_capacity  int;
  v_confirmed int;
  v_next      private.registrations;
  v_number    int;
  v_promoted  jsonb := null;
begin
  delete from private.registrations where id = p_id returning * into v_row;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  if v_row.status = 'confirmed' then
    select s.capacity into v_capacity from private.settings s where s.id = 1;
    select count(*) into v_confirmed from private.registrations where status = 'confirmed';
    if v_confirmed < v_capacity then
      select * into v_next
      from private.registrations
      where status = 'waiting'
      order by id
      limit 1
      for update;

      if found then
        update private.settings
           set last_attendance_number = last_attendance_number + 1
         where id = 1
        returning last_attendance_number into v_number;

        update private.registrations
           set status = 'confirmed', attendance_number = v_number, confirmed_at = now()
         where id = v_next.id;

        v_promoted := jsonb_build_object(
          'id', v_next.id, 'fullName', v_next.full_name, 'attendanceNumber', v_number);
      end if;
    end if;
  end if;

  return jsonb_build_object('result', 'ok', 'deletedId', v_row.id, 'promoted', v_promoted);
end;
$$;

---------------------------------------------------------------------------
-- delete_registration (authenticated + private.admins)
---------------------------------------------------------------------------
create or replace function public.delete_registration(p_id bigint)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.assert_admin();
  -- Same lock as register_member / set_capacity
  perform 1 from private.settings where id = 1 for update;
  return private.remove_registration(p_id);
end;
$$;

---------------------------------------------------------------------------
-- cancel_my_registration (anon) — the token proves ownership.
-- Returns only {result}; never reveals who was promoted.
---------------------------------------------------------------------------
create or replace function public.cancel_my_registration(p_token text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  if coalesce(p_token, '') !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('result', 'not_found');
  end if;

  perform 1 from private.settings where id = 1 for update;

  select id into v_id from private.registrations where token_hash = private.hash_token(p_token);
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  perform private.remove_registration(v_id);
  return jsonb_build_object('result', 'ok');
end;
$$;

revoke all on function private.remove_registration(bigint)  from public, anon, authenticated;
revoke all on function public.delete_registration(bigint)   from public, anon, authenticated;
revoke all on function public.cancel_my_registration(text)  from public, anon, authenticated;

grant execute on function public.delete_registration(bigint)  to authenticated;
grant execute on function public.cancel_my_registration(text) to anon;

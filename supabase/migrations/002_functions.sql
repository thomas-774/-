-- 002_functions.sql — all business rules.
-- Public API (schema `public`): register_member, get_my_registration, admin_dashboard, set_capacity.
-- Helpers live in `private` and cannot be called through the API.
-- Every function: SECURITY DEFINER where it touches tables, and SET search_path = ''.

---------------------------------------------------------------------------
-- Helpers
---------------------------------------------------------------------------

-- Trim and collapse whitespace. Mirrors cleanText() in src/shared/phone.ts.
create or replace function private.clean_text(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p, ''), '\s+', ' ', 'g'));
$$;

-- Phone normalization. Mirrors normalizePhone() in src/shared/phone.ts:
--   Arabic-Indic / Persian digits -> 0-9, drop spaces, dashes, parentheses and
--   direction marks, then a leading +20 or 0020 -> 0.
create or replace function private.normalize_phone(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
           when v like '+20%'  then '0' || pg_catalog.substr(v, 4)
           when v like '0020%' then '0' || pg_catalog.substr(v, 5)
           else v
         end
  from (
    select pg_catalog.regexp_replace(
             pg_catalog.translate(coalesce(p, ''), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'),
             '[\s()‎‏‪-‮⁦-⁩-]', '', 'g') as v
  ) s;
$$;

create or replace function private.hash_token(p_token text)
returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_token, 'UTF8')), 'hex');
$$;

create or replace function private.new_token()
returns text
language sql
volatile
set search_path = ''
as $$
  select pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
$$;

-- Client IP from the headers PostgREST passes in `request.headers`.
-- Verify the header on your project during setup (README → "Checking the client IP header").
create or replace function private.client_ip()
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  h json;
begin
  begin
    h := nullif(current_setting('request.headers', true), '')::json;
  exception when others then
    h := null;
  end;
  if h is null then
    return 'unknown';
  end if;
  return coalesce(
    nullif(pg_catalog.btrim(h ->> 'cf-connecting-ip'), ''),
    nullif(pg_catalog.btrim(pg_catalog.split_part(h ->> 'x-forwarded-for', ',', 1)), ''),
    nullif(pg_catalog.btrim(h ->> 'x-real-ip'), ''),
    'unknown'
  );
end;
$$;

-- Rank among waiting rows by arrival (id). Calculated, never stored.
create or replace function private.waiting_position(p_id bigint)
returns int
language sql
stable
set search_path = ''
as $$
  select count(*)::int
  from private.registrations
  where status = 'waiting' and id <= p_id;
$$;

-- The member-facing view of one registration. Never includes the phone number.
create or replace function private.registration_payload(r private.registrations)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select case r.status
    when 'confirmed' then pg_catalog.jsonb_build_object(
      'fullName', r.full_name,
      'status', 'confirmed',
      'attendanceNumber', r.attendance_number)
    else pg_catalog.jsonb_build_object(
      'fullName', r.full_name,
      'status', 'waiting',
      'waitingPosition', private.waiting_position(r.id))
  end;
$$;

-- Raises 42501 (PostgREST -> 401/403) unless the caller is in private.admins.
create or replace function private.assert_admin()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null
     or not exists (select 1 from private.admins a where a.user_id = auth.uid()) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
end;
$$;

---------------------------------------------------------------------------
-- register_member (anon)
---------------------------------------------------------------------------
create or replace function public.register_member(
  p_full_name     text,
  p_phone         text,
  p_faculty       text,
  p_university    text,
  p_submission_id text,
  p_website       text default ''
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_name       text := private.clean_text(p_full_name);
  v_phone      text := private.normalize_phone(p_phone);
  v_faculty    text := private.clean_text(p_faculty);
  v_university text := private.clean_text(p_university);
  v_sub        uuid;
  v_hits       int;
  v_settings   private.settings;
  v_row        private.registrations;
  v_confirmed  int;
  v_number     int;
  v_token      text;
begin
  -- 1. Validate
  if char_length(v_name) not between 2 and 100 then
    return jsonb_build_object('result', 'invalid', 'field', 'full_name');
  end if;
  if v_phone !~ '^01[0125][0-9]{8}$' then
    return jsonb_build_object('result', 'invalid', 'field', 'phone');
  end if;
  if char_length(v_faculty) not between 1 and 100 then
    return jsonb_build_object('result', 'invalid', 'field', 'faculty');
  end if;
  if char_length(v_university) not between 1 and 100 then
    return jsonb_build_object('result', 'invalid', 'field', 'university');
  end if;
  if coalesce(p_submission_id, '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return jsonb_build_object('result', 'invalid', 'field', 'submission_id');
  end if;
  v_sub := p_submission_id::uuid;

  -- 2. Honeypot: fake success, store nothing
  if coalesce(p_website, '') <> '' then
    return jsonb_build_object(
      'result', 'ok', 'token', private.new_token(), 'fullName', v_name,
      'status', 'waiting', 'waitingPosition', 1);
  end if;

  -- 3. Per-IP rate limit (fixed one-minute window)
  insert into private.rate_limits as rl (ip, window_start, count)
  values (private.client_ip(), date_trunc('minute', now()), 1)
  on conflict (ip, window_start) do update set count = rl.count + 1
  returning rl.count into v_hits;

  if random() < 0.01 then
    delete from private.rate_limits where window_start < now() - interval '10 minutes';
  end if;

  if v_hits > (select s.rate_limit_per_minute from private.settings s where s.id = 1) then
    return jsonb_build_object('result', 'rate_limited');
  end if;

  -- 4. One registration at a time from here on (held ~1 ms)
  select * into v_settings from private.settings where id = 1 for update;

  -- 5a. Same submission_id = retry / double-click: return it with a fresh token
  select * into v_row from private.registrations where submission_id = v_sub;
  if found then
    v_token := private.new_token();
    update private.registrations set token_hash = private.hash_token(v_token) where id = v_row.id;
    return jsonb_build_object('result', 'ok', 'token', v_token) || private.registration_payload(v_row);
  end if;

  -- 5b. Phone already used by another submission. Reveal nothing about it.
  if exists (select 1 from private.registrations where phone = v_phone) then
    return jsonb_build_object('result', 'phone_taken');
  end if;

  -- 6. Confirmed or waiting
  select count(*) into v_confirmed from private.registrations where status = 'confirmed';
  v_token := private.new_token();

  if v_confirmed < v_settings.capacity then
    update private.settings
       set last_attendance_number = last_attendance_number + 1
     where id = 1
    returning last_attendance_number into v_number;

    insert into private.registrations
      (full_name, phone, faculty, university, status, attendance_number,
       token_hash, submission_id, confirmed_at)
    values
      (v_name, v_phone, v_faculty, v_university, 'confirmed', v_number,
       private.hash_token(v_token), v_sub, now())
    returning * into v_row;
  else
    insert into private.registrations
      (full_name, phone, faculty, university, status, token_hash, submission_id)
    values
      (v_name, v_phone, v_faculty, v_university, 'waiting', private.hash_token(v_token), v_sub)
    returning * into v_row;
  end if;

  -- 7-8. Return the raw token once; only its hash is stored
  return jsonb_build_object('result', 'ok', 'token', v_token) || private.registration_payload(v_row);
end;
$$;

---------------------------------------------------------------------------
-- get_my_registration (anon)
---------------------------------------------------------------------------
create or replace function public.get_my_registration(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_row private.registrations;
begin
  if coalesce(p_token, '') !~ '^[0-9a-f]{64}$' then
    return null;
  end if;
  select * into v_row from private.registrations where token_hash = private.hash_token(p_token);
  if not found then
    return null;
  end if;
  return private.registration_payload(v_row);
end;
$$;

---------------------------------------------------------------------------
-- admin_dashboard (authenticated + private.admins)
---------------------------------------------------------------------------
create or replace function public.admin_dashboard()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_settings private.settings;
  v_result   jsonb;
begin
  perform private.assert_admin();

  select * into v_settings from private.settings where id = 1;

  select jsonb_build_object(
    'capacity', v_settings.capacity,
    'lastAttendanceNumber', v_settings.last_attendance_number,
    'confirmed', count(*) filter (where r.status = 'confirmed'),
    'waiting', count(*) filter (where r.status = 'waiting'),
    'total', count(*),
    'registrations', coalesce(
      jsonb_agg(jsonb_build_object(
        'id', r.id,
        'attendanceNumber', r.attendance_number,
        'fullName', r.full_name,
        'phone', r.phone,
        'faculty', r.faculty,
        'university', r.university,
        'status', r.status,
        'waitingPosition', r.waiting_position,
        'createdAt', r.created_at,
        'confirmedAt', r.confirmed_at
      ) order by r.status, r.attendance_number, r.id),
      '[]'::jsonb)
  )
  into v_result
  from (
    select x.*,
           case when x.status = 'waiting'
                then row_number() over (partition by x.status order by x.id)
           end as waiting_position
    from private.registrations x
  ) r;

  return v_result;
end;
$$;

---------------------------------------------------------------------------
-- set_capacity (authenticated + private.admins)
---------------------------------------------------------------------------
create or replace function public.set_capacity(p_new_capacity int)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_settings  private.settings;
  v_confirmed int;
  v_free      int;
  v_last      int;
  v_promoted  jsonb := '[]'::jsonb;
  w           record;
begin
  perform private.assert_admin();

  -- Same lock as register_member: no registration can slip in mid-promotion
  select * into v_settings from private.settings where id = 1 for update;
  select count(*) into v_confirmed from private.registrations where status = 'confirmed';

  if p_new_capacity is null or p_new_capacity < 1 or p_new_capacity > 100000 then
    return jsonb_build_object('result', 'invalid', 'reason', 'out_of_range');
  end if;
  if p_new_capacity < v_confirmed then
    return jsonb_build_object('result', 'invalid', 'reason', 'below_confirmed', 'confirmed', v_confirmed);
  end if;

  v_free := p_new_capacity - v_confirmed;
  v_last := v_settings.last_attendance_number;

  if v_free > 0 then
    for w in
      select id, full_name
      from private.registrations
      where status = 'waiting'
      order by id
      limit v_free
      for update
    loop
      v_last := v_last + 1;
      update private.registrations
         set status = 'confirmed', attendance_number = v_last, confirmed_at = now()
       where id = w.id;
      v_promoted := v_promoted || jsonb_build_array(
        jsonb_build_object('id', w.id, 'fullName', w.full_name, 'attendanceNumber', v_last));
    end loop;
  end if;

  update private.settings
     set capacity = p_new_capacity, last_attendance_number = v_last
   where id = 1;

  return jsonb_build_object(
    'result', 'ok',
    'capacity', p_new_capacity,
    'promotedCount', jsonb_array_length(v_promoted),
    'promoted', v_promoted);
end;
$$;

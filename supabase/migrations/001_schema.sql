-- 001_schema.sql — private schema, tables, constraints, indexes, seed.
-- Tables live in `private`, which is NOT exposed by the Supabase API (see 003_permissions.sql).

create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;

create type private.registration_status as enum ('confirmed', 'waiting');

-- Exactly one row (id = 1). Locked FOR UPDATE by register_member and set_capacity,
-- which serializes numbering and promotions.
create table private.settings (
  id                     int primary key default 1 check (id = 1),
  capacity               int not null default 200 check (capacity >= 1),
  last_attendance_number int not null default 0   check (last_attendance_number >= 0),
  rate_limit_per_minute  int not null default 30  check (rate_limit_per_minute >= 1)
);

insert into private.settings (id, capacity, last_attendance_number, rate_limit_per_minute)
values (1, 200, 0, 30);

create table private.registrations (
  id                bigserial primary key,          -- also the arrival order
  full_name         text not null check (char_length(full_name) between 2 and 100),
  phone             text not null unique check (phone ~ '^01[0125][0-9]{8}$'),
  faculty           text not null check (char_length(faculty) between 1 and 100),
  university        text not null check (char_length(university) between 1 and 100),
  status            private.registration_status not null,
  attendance_number int unique check (attendance_number >= 1),
  token_hash        text not null unique,           -- SHA-256 (hex) of the member's token
  submission_id     uuid not null unique,           -- idempotency key from the form
  created_at        timestamptz not null default now(),
  confirmed_at      timestamptz,
  constraint confirmed_has_number check ((status = 'confirmed') = (attendance_number is not null))
);

create index registrations_status_id_idx on private.registrations (status, id);

create table private.admins (
  user_id uuid primary key references auth.users (id) on delete cascade
);

create table private.rate_limits (
  ip           text not null,
  window_start timestamptz not null,
  count        int not null default 0,
  primary key (ip, window_start)
);

create index rate_limits_window_start_idx on private.rate_limits (window_start);

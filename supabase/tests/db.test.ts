// Database tests (plan §12), run against the real migrations in PGlite.
// True parallel concurrency needs a real server: see supabase/tests/remote-checks.mjs.
import { beforeEach, describe, expect, it } from 'vitest';
import { asRole, freshDb, phoneFor, register, uuid, type Db, type RegisterResult } from './helpers';
import { normalizePhone } from '../../src/shared/phone';

const ADMIN = '11111111-1111-4111-8111-111111111111';
const NOT_ADMIN = '22222222-2222-4222-8222-222222222222';

let db: Db;

async function setup(capacity = 200) {
  db = await freshDb();
  await db.exec(`
    update private.settings set capacity = ${capacity}, rate_limit_per_minute = 100000;
    insert into auth.users (id) values ('${ADMIN}'), ('${NOT_ADMIN}');
    insert into private.admins (user_id) values ('${ADMIN}');
  `);
}

const setCapacity = (n: number, uid = ADMIN) =>
  asRole<{ result: string; promotedCount?: number; promoted?: { attendanceNumber: number }[]; reason?: string }>(
    db, 'authenticated', 'select public.set_capacity($1)', [n], { uid });

const dashboard = (uid = ADMIN) =>
  asRole<{
    capacity: number; confirmed: number; waiting: number; total: number;
    registrations: { status: string; attendanceNumber: number | null; waitingPosition: number | null; phone: string }[];
  }>(db, 'authenticated', 'select public.admin_dashboard()', [], { uid });

const lookup = (token: string) =>
  asRole<RegisterResult | null>(db, 'anon', 'select public.get_my_registration($1)', [token]);

describe('register_member', () => {
  beforeEach(() => setup(3));

  it('numbers confirmed members 1..capacity, then puts the rest on the waiting list', async () => {
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await register(db));
    expect(results.map((r) => r.attendanceNumber ?? null)).toEqual([1, 2, 3, null, null]);
    expect(results.map((r) => r.waitingPosition ?? null)).toEqual([null, null, null, 1, 2]);
    expect(results.every((r) => r.result === 'ok' && /^[0-9a-f]{64}$/.test(r.token!))).toBe(true);
  });

  it('stores only the token hash and normalized, cleaned values', async () => {
    const r = await register(db, { name: '  مينا   جرجس ', phone: '+20 100 123 4567' });
    const row = (await db.query<{ full_name: string; phone: string; token_hash: string }>(
      'select full_name, phone, token_hash from private.registrations')).rows[0];
    expect(row.full_name).toBe('مينا جرجس');
    expect(row.phone).toBe('01001234567');
    expect(row.token_hash).not.toBe(r.token);
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('treats the same phone in another format as taken, without revealing anything', async () => {
    await register(db, { phone: '01001234567' });
    const second = await register(db, { phone: '+20 100-123-4567' });
    expect(second).toEqual({ result: 'phone_taken' });
    const third = await register(db, { phone: '٠١٠٠١٢٣٤٥٦٧' });
    expect(third).toEqual({ result: 'phone_taken' });
  });

  it('is idempotent for the same submission_id and issues a fresh token', async () => {
    const sub = uuid();
    const a = await register(db, { phone: phoneFor(900), sub });
    const b = await register(db, { phone: phoneFor(900), sub });
    expect(b.attendanceNumber).toBe(a.attendanceNumber);
    expect(b.token).not.toBe(a.token);
    expect((await db.query('select 1 from private.registrations')).rows).toHaveLength(1);
    expect(await lookup(a.token!)).toBeNull();
    expect((await lookup(b.token!))?.attendanceNumber).toBe(1);
  });

  it('rejects invalid input field by field', async () => {
    expect(await register(db, { name: 'م' })).toEqual({ result: 'invalid', field: 'full_name' });
    expect(await register(db, { name: 'م'.repeat(101) })).toEqual({ result: 'invalid', field: 'full_name' });
    expect(await register(db, { phone: '0131234567' })).toEqual({ result: 'invalid', field: 'phone' });
    expect(await register(db, { phone: '01312345678' })).toEqual({ result: 'invalid', field: 'phone' });
    expect(await register(db, { faculty: '   ' })).toEqual({ result: 'invalid', field: 'faculty' });
    expect(await register(db, { university: 'x'.repeat(101) })).toEqual({ result: 'invalid', field: 'university' });
    expect(await register(db, { sub: 'not-a-uuid' })).toEqual({ result: 'invalid', field: 'submission_id' });
    expect((await db.query('select 1 from private.registrations')).rows).toHaveLength(0);
  });

  it('fakes success for the honeypot and stores nothing', async () => {
    const r = await register(db, { website: 'http://spam.example' });
    expect(r.result).toBe('ok');
    expect((await db.query('select 1 from private.registrations')).rows).toHaveLength(0);
    expect(await lookup(r.token!)).toBeNull();
  });

  it('rate-limits per IP', async () => {
    await db.exec('update private.settings set capacity = 100, rate_limit_per_minute = 3');
    for (let i = 0; i < 3; i++) expect((await register(db, {}, { ip: '1.2.3.4' })).result).toBe('ok');
    expect(await register(db, {}, { ip: '1.2.3.4' })).toEqual({ result: 'rate_limited' });
    expect((await register(db, {}, { ip: '5.6.7.8' })).result).toBe('ok');
  });
});

describe('get_my_registration', () => {
  beforeEach(() => setup(1));

  it('returns name/status/number, never the phone', async () => {
    const a = await register(db, { name: 'أبانوب' });
    const b = await register(db, { name: 'مارينا' });
    expect(await lookup(a.token!)).toEqual({ fullName: 'أبانوب', status: 'confirmed', attendanceNumber: 1 });
    expect(await lookup(b.token!)).toEqual({ fullName: 'مارينا', status: 'waiting', waitingPosition: 1 });
  });

  it('returns null for unknown or malformed tokens', async () => {
    expect(await lookup('0'.repeat(64))).toBeNull();
    expect(await lookup("' or 1=1 --")).toBeNull();
  });
});

describe('set_capacity', () => {
  beforeEach(() => setup(200));

  it('200 → 210 with 15 waiting promotes the first 10 as 201–210', async () => {
    const all: RegisterResult[] = [];
    for (let i = 0; i < 215; i++) all.push(await register(db));
    expect(all.filter((r) => r.status === 'waiting')).toHaveLength(15);

    const res = await setCapacity(210);
    expect(res.result).toBe('ok');
    expect(res.promoted!.map((p) => p.attendanceNumber)).toEqual([201, 202, 203, 204, 205, 206, 207, 208, 209, 210]);

    // First 10 waiting by arrival were promoted; the other 5 are now at 1–5
    const after = await Promise.all(all.slice(200).map((r) => lookup(r.token!)));
    expect(after.slice(0, 10).map((r) => r!.attendanceNumber)).toEqual([201, 202, 203, 204, 205, 206, 207, 208, 209, 210]);
    expect(after.slice(10).map((r) => r!.waitingPosition)).toEqual([1, 2, 3, 4, 5]);

    const d = await dashboard();
    expect([d.capacity, d.confirmed, d.waiting, d.total]).toEqual([210, 210, 5, 215]);
    const numbers = d.registrations.filter((r) => r.status === 'confirmed').map((r) => r.attendanceNumber);
    expect(numbers).toEqual(Array.from({ length: 210 }, (_, i) => i + 1));
    expect(d.registrations.filter((r) => r.status === 'waiting').map((r) => r.waitingPosition)).toEqual([1, 2, 3, 4, 5]);
  });

  it('rejects lowering below the confirmed count; numbers are never reused', async () => {
    await db.exec('update private.settings set capacity = 3');
    for (let i = 0; i < 5; i++) await register(db);
    expect(await setCapacity(2)).toMatchObject({ result: 'invalid', reason: 'below_confirmed' });
    expect(await setCapacity(0)).toMatchObject({ result: 'invalid', reason: 'out_of_range' });

    // Lower to exactly confirmed (allowed), raise again: numbering continues from the counter
    expect((await setCapacity(3)).promotedCount).toBe(0);
    const raised = await setCapacity(4);
    expect(raised.promoted!.map((p) => p.attendanceNumber)).toEqual([4]);
    const next = await register(db);
    expect(next.status).toBe('waiting');
    expect((await setCapacity(10)).promoted!.map((p) => p.attendanceNumber)).toEqual([5, 6]);
    expect((await register(db)).attendanceNumber).toBe(7);
  });
});

describe('admin access', () => {
  beforeEach(() => setup(200));

  it('rejects anon and non-admin users', async () => {
    await expect(asRole(db, 'anon', 'select public.admin_dashboard()')).rejects.toThrow(/permission denied/);
    await expect(asRole(db, 'anon', 'select public.set_capacity(500)')).rejects.toThrow(/permission denied/);
    await expect(dashboard(NOT_ADMIN)).rejects.toThrow(/not authorized/);
    await expect(setCapacity(500, NOT_ADMIN)).rejects.toThrow(/not authorized/);
    await expect(asRole(db, 'authenticated', 'select public.admin_dashboard()')).rejects.toThrow(/not authorized/);
  });

  it('gives API roles no access to private tables or helpers', async () => {
    for (const role of ['anon', 'authenticated'] as const) {
      await expect(asRole(db, role, 'select * from private.registrations')).rejects.toThrow(/permission denied/);
      await expect(asRole(db, role, "insert into private.settings values (1, 1, 1, 1)")).rejects.toThrow(/permission denied/);
      await expect(asRole(db, role, "select private.new_token()")).rejects.toThrow(/permission denied/);
    }
  });
});

describe('phone normalization: browser and database agree', () => {
  beforeEach(() => setup(200));

  const cases = [
    '01001234567', '+20 100 123 4567', '0020 100 123 4567', '(010) 0123-4567',
    '٠١٠٠١٢٣٤٥٦٧', '۰۱۲۳۴۵۶۷۸۹۰', '‎+20 112 345 6789', '+201512345678', '01312345678',
    '2001001234567', '', 'abc', '010 0123 45678 9',
  ];

  it.each(cases)('%j', async (input) => {
    const sql = (await db.query<{ v: string }>('select private.normalize_phone($1) as v', [input])).rows[0].v;
    expect(normalizePhone(input)).toBe(sql);
  });
});

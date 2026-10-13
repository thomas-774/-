# Implementation Plan — Filo Family Meeting Registration

Status: **code implemented (tasks 2–9, plus the load-test script). Account setup (task 1), the live test runs (task 10), and go-live (task 11) are still to do. See README.md.**

## 1. Goal

A small website where Filo Family members register for the meeting through one shared link. Administrators manage capacity and the waiting list at `/admin`.

The site must be simple, work well on phones, stay fast when everyone opens the link at once, and cost nothing to run.

## 2. Scope

**In scope**
- Public registration form: full name, phone number, faculty/college, university.
- Up to 200 confirmed registrations at first. Each confirmed member gets a unique sequential attendance number starting at 1.
- After capacity is reached, new registrations go to a waiting list.
- A returning visitor on the same browser and device sees their saved status and number.
- Admin dashboard (`/admin`, behind a login): view all registrations, see counts, change capacity, and promote waiting-list members automatically when capacity goes up.

**Out of scope (do not build)**
- Member accounts, passwords, OTP, or special registration codes.
- Member cancellation.
- SMS, email, WhatsApp, or any other notifications.
- Anything else not needed for meeting registration.

## 3. Identity limitation (must be stated, not hidden)

There is no login and no verification, so the system **cannot prove who a person is**.

- **A unique phone number is not proof of identity.** It only stops the same number from being used twice. Anyone can type any number, including someone else's. If someone registers a phone number first, the real owner of that number cannot register it.
- **"Returning member" recognition only works on the same browser and device.** It depends on a random token saved in the browser's `localStorage`. It does **not** work if the member:
  - uses another phone or computer,
  - uses another browser on the same device,
  - uses private/incognito mode, or
  - clears site data.
- **Status cannot be looked up by phone number.** The site will not offer "enter your phone to see your number". Without verification, that would let anyone see someone else's registration. A member who lost their saved status must ask an administrator, who can find them in the dashboard.
- **Automated or fake sign-ups** can only be reduced, not prevented (see §8).

These limits are accepted because accounts and OTP are out of scope. They are also explained on the confirmation screen in one sentence: "حالتك محفوظة على المتصفح ده بس — احتفظ بالصفحة أو خد سكرين شوت." (Your status is saved on this browser only. Keep the page or take a screenshot.)

## 4. Architecture: static site + Supabase, no server of our own

```
 Member's phone ──(static files)──▶ Cloudflare Pages CDN
        │
        └──(HTTPS, 1 call)──▶ Supabase (PostgreSQL + its built-in API)
                                   └─ all rules run inside database functions
 Admin's browser ──(Supabase Auth login)──▶ Supabase
```

- There is **no backend code to write, host, or maintain.** The website is plain HTML, CSS, and JavaScript files.
- The browser calls Supabase directly through its built-in REST API, which is generated automatically from the database.
- **All the important rules live inside PostgreSQL functions**: numbering, capacity, the waiting list, phone uniqueness, and rate limiting. The browser cannot change those rules, because it can only call those functions. It can never touch the tables directly (§4.2).
- The browser's `localStorage` only remembers *this* member's token, so their status can be shown again. The data itself lives in Supabase.

### 4.1 Technology

| Part | Choice | Why |
|---|---|---|
| Website | **Vite + plain TypeScript** (no framework), two pages: `/` and `/admin` | Very small and fast pages; builds to static files |
| Hosting | **Cloudflare Pages** (free) | Unlimited static bandwidth on the free plan, global CDN with locations close to Egypt, HTTPS included. Handles a sudden rush without limits. |
| Database + API | **Supabase** free plan, region **Frankfurt (eu-central-1)** | PostgreSQL with transactions and row locks, so numbering stays correct under load. The REST API is built in, so there is no server to run. |
| Admin login | **Supabase Auth** (email + password), public sign-up **disabled** | Built in and secure; admins are added by hand |
| Styling | Plain CSS, mobile-first, **Arabic RTL** | Most members register from their phones |

### 4.2 Security model (why "no backend" is still safe)
- Supabase's public `anon` key will be visible in the page. **That is normal and expected.** Safety comes from database permissions, not from hiding the key.
- All tables live in a **`private` schema that is not exposed** by the API. The browser cannot read or write any table directly.
- The exposed `public` schema contains **only functions**:
  - for anyone (`anon`): `register_member(...)` and `get_my_registration(token)`;
  - for logged-in admins only (`authenticated`, and also checked against the `private.admins` table inside each function): `admin_dashboard()` and `set_capacity(new_capacity)`.
- Every function:
  - is `SECURITY DEFINER` with `SET search_path = ''`,
  - fully validates its own input,
  - has `EXECUTE` revoked from `PUBLIC` and granted only to the right role. Postgres grants `EXECUTE` to everyone by default, so the revoke is required.
- Supabase Auth settings: **sign-ups disabled**, so nobody can create an account. Admin users are created by hand in the Supabase dashboard and added to `private.admins`.

### 4.3 Cost
- **$0/month.** Supabase free plan, Cloudflare Pages free plan.
- Optional: a custom domain, about $10/year. Without one, the link looks like `philo-family.pages.dev`.
- Supabase free-plan facts that affect us:
  - The project **pauses after about 7 days with no activity**. Wake it from the dashboard a day before sharing the link. Data is not lost.
  - **No automatic backups.** See §13 for the manual backup step.

## 5. Data model (schema `private`)

**`settings`** (exactly one row)
| Column | Type | Notes |
|---|---|---|
| `id` | int PK | always `1` |
| `capacity` | int | starts at `200` |
| `last_attendance_number` | int | starts at `0`; only ever goes up, so a number is never reused |
| `rate_limit_per_minute` | int | starts at `30`; raised temporarily during the load test (§7b) |

**`registrations`**
| Column | Type | Notes |
|---|---|---|
| `id` | bigserial PK | also sets the **arrival order** (used to order the waiting list) |
| `full_name` | text | trimmed, 2–100 characters |
| `phone` | text **UNIQUE** | stored in normalized form (see §6.2) |
| `faculty` | text | trimmed, required, max 100 |
| `university` | text | trimmed, required, max 100 |
| `status` | enum `confirmed` \| `waiting` | |
| `attendance_number` | int **UNIQUE**, nullable | set only when status is `confirmed` |
| `token_hash` | text UNIQUE | SHA-256 of the member's random token; the raw token is never stored |
| `submission_id` | uuid UNIQUE | idempotency key generated by the form (see §6.4) |
| `created_at` | timestamptz | |
| `confirmed_at` | timestamptz, nullable | registration time, or the time of promotion |

Constraint: `CHECK ((status = 'confirmed') = (attendance_number IS NOT NULL))`.
Extra index: `(status, id)`, so waiting-position counts are fast.

**`admins`**: `user_id uuid PK` that references `auth.users`.

**`rate_limits`**: `ip text`, `window_start timestamptz`, `count int`, PK `(ip, window_start)`.

A member's waiting-list position is **calculated, not stored**: their rank among `waiting` rows, ordered by `id`. Positions stay correct automatically after promotions.

## 6. Public site (`/`)

### 6.1 What the page shows
- On load, the page checks `localStorage` for `filo_reg_token`.
  - **No token:** show the **registration form** straight away. This makes **no network call**, so first-time visitors cost the database nothing.
  - **Token found:** call `get_my_registration(token)` and show the **status card**:
    - Confirmed: name, "مؤكد", attendance number in large type.
    - Waiting: name, "قائمة الانتظار", current position (for example "#4"), and the note "ارجع للصفحة دي تاني بعدين — لو فيه أماكن فضيت هتتنقل للمؤكدين تلقائيًا."
    - Token not found in the database (for example, data was reset): remove it from `localStorage` and show the form.
- Layout: header with the Philo Family logo, hero photo of Anba Rofail, then the form or status card. See §7a.

### 6.2 Validation and phone normalization
- All four fields are required. Trim and collapse extra whitespace. Enforce the length limits from §5.
- Phone normalization:
  - convert Arabic-Indic digits (٠-٩) to 0-9,
  - remove spaces, dashes, and parentheses,
  - convert a leading `+20` or `0020` to `0`.
- Then validate the Egyptian mobile pattern `^01[0125]\d{8}$`.
- So `+20 100 123 4567` and `01001234567` count as the **same** number.
- The **database function applies the same rules again**, and its result is the one that counts. The browser check only gives instant feedback.

### 6.3 Registration: `register_member(full_name, phone, faculty, university, submission_id, website)`
`website` is the hidden honeypot field (§8). The browser calls this function through Supabase's REST endpoint `POST /rest/v1/rpc/register_member` in a **single round trip**.

Inside the function, all in one transaction:

1. Validate and normalize all inputs. If anything is invalid, return `{ result: "invalid", field }`.
2. If the honeypot is filled, return a fake success and store nothing.
3. Rate limit by IP (§8). If over the limit, return `{ result: "rate_limited" }`.
4. `SELECT … FROM private.settings WHERE id = 1 FOR UPDATE`. This lock queues registrations one at a time, so two people can never get the same number or both take the last place. It is held for about 1 ms.
5. Look up the normalized phone.
   - It exists **and** has the same `submission_id`: this is a **retry or double-click**. Return the existing registration together with a **new token** (the old hash is replaced), so the browser can save it again.
   - It exists with a different `submission_id`: return `{ result: "phone_taken" }`. Do **not** reveal the name, status, or number.
6. Count confirmed rows.
   - Fewer than `capacity`: set `status = confirmed` and `attendance_number = last_attendance_number + 1`, and increment the counter.
   - Otherwise: set `status = waiting`.
7. Generate a 32-byte random token (`gen_random_bytes`), store its SHA-256 hash, and insert the row.
8. Return `{ result: "ok", token, fullName, status, attendanceNumber | waitingPosition }`.

The browser then saves `token` in `localStorage` and shows the status card.

The function returns results as JSON, not as errors, so the browser has one simple response shape to handle. The unique constraints on `phone`, `attendance_number`, and `submission_id` remain as a final safety net.

### 6.4 Refresh and duplicate-submission safety
- Reloading `/` only reads `localStorage` and, at most, calls `get_my_registration`. A reload **never creates a registration**.
- The form generates a `submission_id` (UUID) when it loads. The submit button is disabled while a request is in flight. A repeated submit with the same id returns the same registration (step 5).
- Phone uniqueness blocks every other kind of repeat.

### 6.5 Status lookup: `get_my_registration(token)`
- Hashes the token and returns `{ fullName, status, attendanceNumber | waitingPosition }`, or `null`.
- Never returns phone numbers or other members' data.

## 7. Admin dashboard (`/admin`)

### 7.1 Authentication
- `/admin` shows a login form (email + password) using `supabase-js`. This library is loaded **only on the admin page**, so the public page stays light.
- Admin accounts are created by hand: Supabase dashboard → Authentication → Add user. Then add the new user's id to `private.admins` with one SQL line (documented in the README).
- Supabase Auth provides the session, token refresh, and built-in login rate limits.
- Every admin function checks that `auth.uid()` is in `private.admins`. Even if someone got a login, a non-admin account could do nothing.
- A logout button ends the session.

### 7.2 Dashboard contents (from `admin_dashboard()`)
- **Counters:** confirmed / capacity, waiting-list count, total.
- **Capacity form:** a number input and a "حفظ" button. Shows the result, for example "السعة بقت 210 — اتنقل 10 من قائمة الانتظار (أرقام 201–210)".
- **Registrations table:**
  - Columns: attendance number, name, phone, faculty/college, university, status, waiting position, registered at.
  - Filter by status and search by name or phone, both done in the browser (the data set is small).
  - Default sort: confirmed first by number, then waiting by position.
  - On narrow screens the table scrolls horizontally inside its own container.
- **Automatic updates:** the dashboard calls `admin_dashboard()` again every **15 seconds** and right after any admin action. Polling is enough at this scale.

### 7.3 Changing capacity: `set_capacity(new_capacity)`
One transaction inside the function:

1. Check that the caller is an admin.
2. Lock `settings` (`FOR UPDATE`). This uses the same lock as registration, so a registration cannot slip in during a promotion.
3. Validate: the new capacity must be an integer, at least 1, and **not less than the current number of confirmed members**. Confirmed members are never demoted, because cancellation is out of scope. Lowering capacity is allowed only down to the confirmed count, and only affects future registrations.
4. Set `capacity = new value`.
5. `free = capacity − confirmedCount`. If `free > 0`:
   - select the first `free` waiting rows, ordered by `id`, `FOR UPDATE`;
   - give each one, in that order: `status = confirmed`, `attendance_number = ++last_attendance_number`, `confirmed_at = now()`.
6. Save `last_attendance_number` and return the list of promoted members.

Example: 200 confirmed, 15 waiting, capacity raised to 210. The first 10 waiting members (by arrival) become confirmed with numbers 201–210. The other 5 stay waiting at positions 1–5. Each member sees the change the next time they open the site. No notifications are sent.

Because `last_attendance_number` only ever goes up, numbers are never reused, even if capacity is lowered and raised again.

## 7a. Branding and visual design

Source assets (already in the repo root):
- `logo philo.png`: Philo Family logo. 2835×2835 PNG with a transparent background, about 2.2 MB.
- `صورة الانبا روفائيل.jpg`: photo of Anba Rofail. 1080×1260 JPG.

### Color palette (taken from the logo)
The values were sampled directly from the logo file. The first three are the logo's own colors. The others are derived from them for text and states.

| Token | Hex | Source / use |
|---|---|---|
| `--brand-gold` | `#FFB217` | Logo ring and "PHILO FAMILY" lettering. Use for primary buttons, the attendance number, focus rings, links, and frame borders. |
| `--brand-brown` | `#382C24` | Logo circle background. Use for cards and surfaces. |
| `--brand-ember` | `#CE4F15` | Rider's red-orange cape. Use as a **decorative** accent only (thin dividers, the "waiting" badge background). Its contrast on brown is too low for text. |
| `--bg` | `#241C17` | Darker shade of the brown. Page background, so the brown cards stand out. |
| `--text` | `#FFF4DF` | Warm cream. Main text on dark surfaces. |
| `--text-muted` | `#CBB89C` | Secondary text and labels. |
| `--on-gold` | `#382C24` | Text on gold buttons (brown on gold, about 7.5:1 contrast). |
| `--error` | `#FF8A5B` | Lighter version of the ember. Error text, readable on brown. |
| `--success` | `#FFB217` | Confirmed state reuses the gold, so there is no new green. |

- **The site uses a dark theme only**, to match the logo's dark circle.
- All colors are defined once as CSS variables on `:root` and used everywhere, admin page included.
- Contrast check: gold on brown and cream on brown both pass WCAG AA for body text. Ember is never used for text.

### How the logo is used
- **Header:** the logo centered at the top of `/`, about 120 px on phones and 160 px on desktop. Under it, the page title on two lines, each in a **different color**:
  - Line 1, `<h1>`: **"اجتماع فيلو فاميلي"** in `--text` (cream `#FFF4DF`), weight 800, about 28 px on phones and 36 px on desktop.
  - Line 2: **"بحضور الأنبا روفائيل"** in `--brand-gold` (`#FFB217`), weight 600, about 20 px on phones and 24 px on desktop.
  - The browser tab title and link-preview title use the same text: "اجتماع فيلو فاميلي — بحضور الأنبا روفائيل".
- **Favicon and home-screen icon:** the logo, exported at 32 px, 180 px (apple-touch-icon), and 192/512 px.
- **Link preview (Open Graph):** a 1200×630 image showing the logo on the `--bg` color, with the same two title lines in the same two colors. When the link is shared on WhatsApp or Facebook, the preview shows the logo and title.
- **Admin page:** a small logo (about 40 px) in the top bar next to "لوحة التحكم".
- The logo is never recolored, stretched, or placed on a light background.

### How the Anba Rofail photo is used
- **Hero on `/`:** between the header and the form.
  - Rounded frame (about 16 px radius) with a 3 px `--brand-gold` border, so it matches the logo ring.
  - Maximum width about 360 px on phones and 420 px on desktop.
  - Keep the original aspect ratio (6:7). Never crop the face. Keep the photographer's credit mark in the bottom-left corner as it is.
  - No caption under the photo. "بحضور الأنبا روفائيل" is already in the header, so it is not repeated.
  - Alt text: "صورة الأنبا روفائيل".
- **Status card:** the photo is **not** repeated. The card stays focused on the member's name, status, and number.
- **Admin page:** the photo is not shown.

### Status card styling
- Confirmed: the attendance number is shown very large, in `--brand-gold` with a gold border, so it is easy to show at the door or screenshot. The label "مؤكد" sits next to it.
- Waiting: an ember-tinted badge "قائمة الانتظار" with the position number in cream text.

### Typography
- Font: **Cairo**, self-hosted as `woff2` files (from the `@fontsource/cairo` package). Arabic and Latin subsets only, weights 400, 600, and 800, with `font-display: swap`.
- Headings and the attendance number use weight 800. Body text uses 400.
- Layout is `dir="rtl"` with `lang="ar"`.

### Image optimization (done once by a script, output committed)
A small Node script (`scripts/build-images.mjs`, using `sharp`) writes to `/public/brand/`:
- from the logo:
  - `logo-160.webp`, `logo-320.webp` (header, 1× and 2×),
  - `logo-80.webp` (admin),
  - favicon and icon sizes,
  - `og.png` (1200×630);
- from the photo: `anba-rofail-360.webp`, `-720.webp`, `-1080.webp`, served with `srcset` and `sizes`, plus explicit `width`/`height` so the page does not jump while loading.

The 2.2 MB original logo is never sent to browsers. Target for the first page load is **under 300 KB in total for images**.

## 7b. Performance under a sudden rush (top priority)

The link will be shared with everyone at once, so most visitors will arrive in the same few minutes. The design keeps almost all of that traffic on the CDN, and makes the part that reaches the database very short.

### Page loads: CDN only, no database work
- `/` is a set of **static files on Cloudflare's CDN**. A thousand visitors opening it at the same moment cause no database queries and have no bandwidth limit on the free plan.
- First-time visitors make **zero API calls** until they press "سجّل" (§6.1).
- Small page budget:
  - public-page JavaScript under **20 KB gzipped**. There is no framework and no `supabase-js` on this page: calls are plain `fetch` to the REST endpoint.
  - images under 300 KB (§7a),
  - Cairo font self-hosted, only the needed subsets.
- Files get content-hashed names and `Cache-Control: immutable`, so return visits load almost instantly. `index.html` itself is revalidated, so a new deploy reaches everyone.

### Registration: one short database call
- One `fetch` → one function call → one transaction. The lock that keeps numbering correct is held for about **1 ms**, so even 500 submissions in one minute queue for well under a second in total.
- Supabase's API server keeps its own pool of database connections, so there is **no connection-limit problem** even when many people submit at once.
- `get_my_registration` is a single indexed lookup.
- Database region Frankfurt is the closest Supabase region to Egypt.

### Behaviour on the user's side during the rush
- The submit button shows a spinner and is disabled while the request runs. Each request has a 10-second timeout.
- On a timeout, network error, or 5xx, the browser **retries automatically up to 3 times** with short back-off (1 s, 2 s, 4 s), reusing the same `submission_id`. Because registration is idempotent (§6.4), a retry can never create a second registration.
- If it still fails, show "الضغط عالي، حاول تاني بعد لحظات" and keep everything the user typed.

### Admin dashboard load
- Only admins poll, once every 15 seconds, reading at most a few hundred rows. This load is negligible.

### Load test before sharing the link (required)
- Use a **second, separate Supabase project for testing** (the free plan allows two), deployed with the same migrations.
- Run a **k6** script:
  - **2,000 page loads** of the Cloudflare site spread over 2 minutes,
  - **500 calls to `register_member`** within 2 minutes, with 100 of them in the same 5 seconds.
- k6 runs from a single IP, so for the test raise `rate_limit_per_minute` in the test project, then set it back.
- Pass criteria:
  - no 5xx errors,
  - `register_member` p95 under 800 ms,
  - page load p95 under 1.5 s on a simulated 4G connection,
  - attendance numbers exactly 1–200 with no duplicates, the rest waiting.
- Before sharing the real link:
  - confirm the production project is awake and its data is empty (`settings` = `(1, 200, 0, 30)`),
  - open the site once yourself about 10 minutes before.

### Free-plan headroom
- About 2,000 visitors and a few hundred registrations use a tiny fraction of the Supabase free limits: database size, API egress, and requests are all far below the caps. Static traffic on Cloudflare Pages is unlimited.
- If the expected crowd is much larger (§11 question 7), the same design scales by upgrading the Supabase compute size for a month. No code changes are needed.

## 8. Abuse and safety (low cost)
- **Honeypot field** (`website`) on the form, hidden from people. A submission that fills it gets a fake success and nothing is stored.
- **Per-IP rate limit** inside `register_member`: **30 per minute per IP** by default.
  - It is deliberately generous because many members may register from the **same church or university Wi-Fi**, which gives them one shared IP.
  - The client IP is read from the request headers that Supabase passes to the database (`request.headers`). Confirm which header carries the real IP during setup.
- Length limits on every field, enforced in the database function.
- All text from the database is inserted into the page with `textContent`, never `innerHTML`, so names cannot inject code.
- Limitation, stated plainly: someone determined could still submit fake entries from many networks. The only fix would be identity verification, which is out of scope.

## 9. Project structure (planned)

```
index.html                     # public page
admin/index.html               # admin page (served at /admin)
src/
  public/main.ts               # form, status card, localStorage token, retry logic
  public/api.ts                # fetch wrappers for the 2 public RPCs
  admin/main.ts                # supabase-js login, dashboard, polling, capacity form
  shared/phone.ts              # browser-side normalization (mirrors the SQL rules)
  shared/config.ts             # Supabase URL + anon key (public values)
  styles/tokens.css            # palette tokens (§7a)
  styles/base.css
public/brand/                  # optimized logo, photo, icons, og.png (§7a)
public/fonts/                  # Cairo woff2 subsets
public/_headers                # Cloudflare cache headers
scripts/build-images.mjs       # one-time image optimization
supabase/migrations/
  001_schema.sql               # private schema, tables, constraints, indexes, seed
  002_functions.sql            # register_member, get_my_registration, admin_dashboard, set_capacity
  003_permissions.sql          # revoke defaults, grants per role
supabase/tests/                # SQL test scripts (§12)
loadtest/rush.k6.js            # rush simulation (§7b)
README.md                      # setup, adding an admin, go-live checklist
```

## 10. Work breakdown

| # | Task | Done when |
|---|---|---|
| 1 | Create two Supabase projects (production + test) in Frankfurt. Disable Auth sign-ups. Set up the Vite project and create the Cloudflare Pages site connected to the Git repo | An empty page deploys to `*.pages.dev` |
| 2 | `001_schema.sql`: `private` schema, tables, constraints, indexes, seed `settings` | Runs cleanly on an empty project |
| 3 | `002_functions.sql`: `register_member`, `get_my_registration` (including normalization, honeypot, rate limit, locking) | SQL tests in §12 pass |
| 4 | `003_permissions.sql`: revoke `EXECUTE` from `PUBLIC`; grant public functions to `anon` and admin functions to `authenticated`; confirm tables are not reachable through the API | Direct REST calls to the tables fail; only the 4 functions respond |
| 5 | Branding setup: image script, icons, OG image, palette tokens, Cairo font (§7a) | All brand assets under 300 KB on the first load |
| 6 | Public page: header logo, Anba Rofail hero photo, form, status card, `localStorage` token, retry logic, RTL, mobile-first | Matches §7a; works on a 360 px wide phone; clear Arabic error messages |
| 7 | `admin_dashboard()` and `set_capacity()` functions + admin check | The 200 → 210 scenario passes |
| 8 | Admin page: login, counters, table, filters, capacity form, 15 s polling | Shows live data; non-admin login is rejected |
| 9 | README: setup, adding an admin, manual backup, go-live checklist | Another person could set it up from the README alone |
| 10 | k6 load test on the test project (§7b) | All pass criteria in §7b met |
| 11 | Go-live: production project migrated and empty, first admin added, smoke test on real Android and iPhone | Public link works over HTTPS |

## 11. Open questions (defaults used until answered)

1. **Phone format:** Egyptian mobile numbers only? *Default: yes (`01xxxxxxxxx`).*
2. **Lowering capacity:** allowed down to the confirmed count? *Default: yes, as described in §7.3.*
3. **Closing registration:** should the form close at a set date or time? *Default: no, because it was not requested.*
4. **Removing spam entries:** should admins be able to delete obviously fake rows? This is not in the current requirements and is left out. Without it, fake entries take real places.
5. **Admin language:** Arabic like the public page? *Default: Arabic RTL.*
6. ~~Page title~~ **Settled:** "اجتماع فيلو فاميلي" (cream) + "بحضور الأنبا روفائيل" (gold), see §7a.
7. **Expected peak:** roughly how many people will open the link in the first few minutes? *Default: design and load-test for 2,000 visitors and 500 submissions within 2 minutes (§7b).*

## 12. Testing plan
- **Unit (browser code):** phone normalization gives the same result as the SQL version for every test case; form validation.
- **Database tests (SQL scripts run against the test project):**
  - Concurrency: 250 `register_member` calls sent **in parallel**. Result: exactly 200 confirmed, numbers exactly 1–200 with no gaps or duplicates, and 50 waiting.
  - Same phone in different formats → the second call returns `phone_taken`.
  - Same `submission_id` sent twice → one row, same attendance number in both responses.
  - Honeypot filled → fake success, no row.
  - Over the rate limit → `rate_limited`.
  - Capacity 200 → 210 with 15 waiting → the first 10 by arrival get 201–210, and the remaining 5 have positions 1–5.
  - Capacity lowered below the confirmed count → rejected. Raised again later → numbers continue from the counter and are never reused.
  - Registration and capacity change at the same time → no duplicate numbers.
- **Security checks (with the `anon` key, as an attacker would):**
  - reading or writing any table through the REST API fails,
  - calling `admin_dashboard` or `set_capacity` fails,
  - signing up a new account fails,
  - a logged-in non-admin user cannot call the admin functions.
- **Load:** the k6 rush scenario in §7b.
- **Manual:** Android and iPhone browsers, a narrow screen, RTL layout, a reload after registering (shows the status card, no new row), and incognito mode (shows the form again, the expected limitation).

## 13. Deployment and operations
- **Hosting:** Cloudflare Pages builds and deploys automatically on every push to `main`. The Supabase URL and anon key are public values and live in `src/shared/config.ts`. **No secret keys are ever put in the website.** The `service_role` key is never used in the website.
- **Database changes:** apply the SQL files in `supabase/migrations/` in order. Use the Supabase SQL editor, or `supabase db push` with the Supabase CLI.
- **Keep it awake:** the free project pauses after about 7 days without activity. Open the dashboard a day before sharing the link.
- **Backups (manual, because the free plan has none):**
  - In Supabase → Table Editor → `registrations` → **Export to CSV**.
  - Do this at least once after registration closes, and ideally once a day while it is open.
  - No export feature is built into the site.
- No ongoing maintenance besides keeping admin passwords safe.

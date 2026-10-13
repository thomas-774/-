-- Run in the TEST project's SQL editor after the k6 rush (plan §7b pass criteria).

-- Expect: confirmed = 200, min = 1, max = 200, distinct = 200
select count(*)                          as confirmed,
       min(attendance_number)            as min_number,
       max(attendance_number)            as max_number,
       count(distinct attendance_number) as distinct_numbers
from private.registrations
where status = 'confirmed';

-- Expect: everyone else waiting (500 - 200 = 300 for the full scenario)
select status, count(*) from private.registrations group by status;

-- Expect: no rows (no gaps in 1..200)
select n as missing_number
from generate_series(1, 200) n
where not exists (select 1 from private.registrations r where r.attendance_number = n);

-- Afterwards: restore the rate limit
-- update private.settings set rate_limit_per_minute = 30 where id = 1;

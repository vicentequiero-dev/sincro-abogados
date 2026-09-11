begin;

create table public.reservation_hold_rate_limits (
  ip_hash text primary key,
  window_started_at timestamptz not null,
  hold_count integer not null default 0,
  updated_at timestamptz not null default now(),
  constraint reservation_hold_rate_limits_ip_hash_format
    check (ip_hash ~ '^[0-9a-f]{64}$'),
  constraint reservation_hold_rate_limits_hold_count_nonnegative
    check (hold_count >= 0)
);

create index reservation_hold_rate_limits_updated_at_idx
  on public.reservation_hold_rate_limits (updated_at);

alter table public.reservation_hold_rate_limits enable row level security;

revoke all on table public.reservation_hold_rate_limits from public;
revoke all on table public.reservation_hold_rate_limits from anon;
revoke all on table public.reservation_hold_rate_limits from authenticated;

create or replace function public.create_reservation_hold_limited(
  p_ip_hash text,
  p_customer_name text,
  p_customer_email text,
  p_customer_phone text,
  p_customer_phone_identity text,
  p_practice_area text,
  p_start_at timestamptz,
  p_end_at timestamptz
)
returns table (
  decision text,
  reservation_id uuid,
  hold_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_local_start timestamp;
  v_local_today date;
  v_customer_name text := btrim(p_customer_name);
  v_customer_email text := lower(btrim(p_customer_email));
  v_customer_phone text := btrim(p_customer_phone);
  v_phone_digits text;
  v_phone_identity text;
  v_practice_area text := btrim(p_practice_area);
  v_rate_limit public.reservation_hold_rate_limits%rowtype;
  v_constraint_name text;
begin
  v_phone_digits := regexp_replace(
    coalesce(v_customer_phone, ''),
    '[^0-9]',
    '',
    'g'
  );

  v_phone_identity := case
    when v_phone_digits ~ '^569[0-9]{8}$'
      then substr(v_phone_digits, 3)
    when v_phone_digits ~ '^9[0-9]{8}$'
      then v_phone_digits
    else v_phone_digits
  end;

  if p_ip_hash is null
     or p_ip_hash !~ '^[0-9a-f]{64}$'
     or v_customer_name is null
     or length(v_customer_name) not between 2 and 120
     or v_customer_name ~ '[[:cntrl:]]'
     or v_customer_email is null
     or length(v_customer_email) not between 3 and 254
     or v_customer_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
     or v_customer_phone is null
     or length(v_customer_phone) not between 7 and 30
     or v_phone_digits !~ '^[0-9]{7,30}$'
     or p_customer_phone_identity is null
     or p_customer_phone_identity <> v_phone_identity
     or v_practice_area is null
     or length(v_practice_area) not between 2 and 120
     or v_practice_area ~ '[[:cntrl:]]'
     or p_start_at is null
     or p_end_at is null
     or p_end_at <> p_start_at + interval '30 minutes'
  then
    decision := 'invalid_input';
    return next;
    return;
  end if;

  v_local_start := p_start_at at time zone 'America/Santiago';
  v_local_today := (v_now at time zone 'America/Santiago')::date;

  if extract(isodow from v_local_start) not between 1 and 5
     or v_local_start::time not in (
       time '14:00',
       time '14:30',
       time '15:00',
       time '15:30',
       time '16:00'
     )
     or v_local_start::date < v_local_today
     or v_local_start::date > v_local_today + 30
     or p_start_at < v_now + interval '2 hours'
  then
    decision := 'invalid_input';
    return next;
    return;
  end if;

  -- Every invocation acquires the same logical lock classes in this order.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('reservation-hold:ip:' || p_ip_hash, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'reservation-hold:email:' || v_customer_email,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'reservation-hold:phone:' || v_phone_identity,
      0
    )
  );

  update public.reservations as r
     set status = 'expired'::public.reservation_status,
         updated_at = v_now
   where r.status = 'pending_payment'::public.reservation_status
     and r.hold_expires_at <= v_now;

  insert into public.reservation_hold_rate_limits as limits (
    ip_hash,
    window_started_at,
    hold_count,
    updated_at
  )
  values (p_ip_hash, v_now, 0, v_now)
  on conflict (ip_hash) do nothing;

  select limits.*
    into v_rate_limit
    from public.reservation_hold_rate_limits as limits
   where limits.ip_hash = p_ip_hash
   for update;

  if v_rate_limit.window_started_at <= v_now - interval '15 minutes' then
    update public.reservation_hold_rate_limits as limits
       set window_started_at = v_now,
           hold_count = 0,
           updated_at = v_now
     where limits.ip_hash = p_ip_hash
     returning limits.* into v_rate_limit;
  end if;

  if v_rate_limit.hold_count >= 3 then
    decision := 'rate_limited';
    return next;
    return;
  end if;

  if exists (
    select 1
      from public.reservations as r
     where r.status = 'pending_payment'::public.reservation_status
       and r.hold_expires_at > v_now
       and (
         lower(btrim(r.customer_email)) = v_customer_email
         or (
           case
             when regexp_replace(r.customer_phone, '[^0-9]', '', 'g')
                    ~ '^569[0-9]{8}$'
               then substr(
                 regexp_replace(r.customer_phone, '[^0-9]', '', 'g'),
                 3
               )
             when regexp_replace(r.customer_phone, '[^0-9]', '', 'g')
                    ~ '^9[0-9]{8}$'
               then regexp_replace(r.customer_phone, '[^0-9]', '', 'g')
             else regexp_replace(r.customer_phone, '[^0-9]', '', 'g')
           end
         ) = v_phone_identity
       )
     limit 1
  ) then
    decision := 'rate_limited';
    return next;
    return;
  end if;

  hold_expires_at := v_now + interval '10 minutes';

  begin
    insert into public.reservations (
      customer_name,
      customer_email,
      customer_phone,
      practice_area,
      start_at,
      end_at,
      status,
      hold_expires_at,
      amount
    )
    values (
      v_customer_name,
      v_customer_email,
      v_customer_phone,
      v_practice_area,
      p_start_at,
      p_end_at,
      'pending_payment'::public.reservation_status,
      hold_expires_at,
      15000
    )
    returning id into reservation_id;
  exception
    when exclusion_violation then
      get stacked diagnostics
        v_constraint_name = constraint_name;

      if v_constraint_name <> 'reservations_no_active_overlap' then
        raise;
      end if;

      decision := 'slot_unavailable';
      reservation_id := null;
      hold_expires_at := null;
      return next;
      return;
  end;

  update public.reservation_hold_rate_limits as limits
     set hold_count = limits.hold_count + 1,
         updated_at = v_now
   where limits.ip_hash = p_ip_hash;

  decision := 'created';
  return next;
end;
$function$;

revoke all
  on function public.create_reservation_hold_limited(
    text,
    text,
    text,
    text,
    text,
    text,
    timestamptz,
    timestamptz
  )
  from public;

revoke all
  on function public.create_reservation_hold_limited(
    text,
    text,
    text,
    text,
    text,
    text,
    timestamptz,
    timestamptz
  )
  from anon, authenticated;

grant execute
  on function public.create_reservation_hold_limited(
    text,
    text,
    text,
    text,
    text,
    text,
    timestamptz,
    timestamptz
  )
  to service_role;

commit;

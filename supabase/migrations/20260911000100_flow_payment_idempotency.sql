begin;

create type public.flow_payment_creation_status as enum (
  'not_started',
  'creating',
  'created',
  'failed',
  'ambiguous'
);

alter table public.reservations
  add column flow_payment_status public.flow_payment_creation_status not null default 'not_started',
  add column flow_payment_attempt_id uuid,
  add column flow_payment_started_at timestamptz,
  add column flow_checkout_url text;

-- Preserve any pre-existing Flow references conservatively. Without the original
-- checkout token, those rows cannot be considered safely recoverable.
update public.reservations
set
  commerce_order = coalesce(
    commerce_order,
    'sincro-' || replace(id::text, '-', '')
  ),
  flow_payment_status = 'ambiguous',
  flow_payment_attempt_id = gen_random_uuid(),
  flow_payment_started_at = coalesce(updated_at, created_at, now())
where commerce_order is not null
   or flow_order is not null;

alter table public.reservations
  add constraint reservations_flow_payment_attempt_id_key
    unique (flow_payment_attempt_id),
  add constraint reservations_flow_order_key
    unique (flow_order),
  add constraint reservations_flow_checkout_url_https
    check (
      flow_checkout_url is null
      or flow_checkout_url ~ '^https://[^[:space:]]+$'
    ),
  add constraint reservations_flow_payment_state_valid
    check (
      (
        flow_payment_status = 'not_started'
        and commerce_order is null
        and flow_order is null
        and flow_checkout_url is null
        and flow_payment_attempt_id is null
        and flow_payment_started_at is null
      )
      or
      (
        flow_payment_status = 'creating'
        and commerce_order is not null
        and flow_order is null
        and flow_checkout_url is null
        and flow_payment_attempt_id is not null
        and flow_payment_started_at is not null
      )
      or
      (
        flow_payment_status = 'created'
        and commerce_order is not null
        and flow_order is not null
        and flow_checkout_url is not null
        and flow_payment_attempt_id is not null
        and flow_payment_started_at is not null
      )
      or
      (
        flow_payment_status = 'failed'
        and commerce_order is not null
        and flow_order is null
        and flow_checkout_url is null
        and flow_payment_attempt_id is not null
        and flow_payment_started_at is not null
      )
      or
      (
        flow_payment_status = 'ambiguous'
        and commerce_order is not null
        and flow_checkout_url is null
        and flow_payment_attempt_id is not null
        and flow_payment_started_at is not null
      )
    );

comment on column public.reservations.flow_payment_status is
  'Lifecycle of the external Flow payment-order creation attempt.';
comment on column public.reservations.flow_payment_attempt_id is
  'Capability identifying the backend invocation allowed to finalize the current Flow attempt.';
comment on column public.reservations.flow_payment_started_at is
  'Timestamp at which the current or most recent Flow creation attempt was claimed.';
comment on column public.reservations.flow_checkout_url is
  'Recoverable Flow checkout URL, including its token. Backend-only sensitive data.';

create or replace function public.claim_flow_payment(p_reservation_id uuid)
returns table (
  decision text,
  attempt_id uuid,
  commerce_order text,
  checkout_url text,
  hold_expires_at timestamptz,
  amount integer,
  customer_email text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation public.reservations%rowtype;
  v_now timestamptz := clock_timestamp();
  v_attempt_id uuid;
  v_commerce_order text;
begin
  select r.*
  into v_reservation
  from public.reservations as r
  where r.id = p_reservation_id
  for update;

  if not found then
    decision := 'not_found';
    return next;
    return;
  end if;

  hold_expires_at := v_reservation.hold_expires_at;
  amount := v_reservation.amount;

  if v_reservation.status <> 'pending_payment'::public.reservation_status then
    decision := 'invalid_status';
    return next;
    return;
  end if;

  if v_reservation.amount <> 15000 then
    decision := 'invalid_amount';
    return next;
    return;
  end if;

  if v_reservation.hold_expires_at is null
     or v_reservation.hold_expires_at <= v_now then
    update public.reservations as r
    set
      status = 'expired'::public.reservation_status,
      updated_at = v_now
    where r.id = p_reservation_id;

    decision := 'expired';
    return next;
    return;
  end if;

  if v_reservation.flow_payment_status = 'created'
     and v_reservation.flow_checkout_url is not null then
    decision := 'reuse';
    attempt_id := v_reservation.flow_payment_attempt_id;
    commerce_order := v_reservation.commerce_order;
    checkout_url := v_reservation.flow_checkout_url;
    return next;
    return;
  end if;

  if v_reservation.flow_payment_status = 'creating' then
    -- A stale creator is never retried automatically: its external result is unknown.
    if v_reservation.flow_payment_started_at <= v_now - interval '2 minutes' then
      update public.reservations as r
      set
        flow_payment_status = 'ambiguous',
        updated_at = v_now
      where r.id = p_reservation_id;

      decision := 'ambiguous';
    else
      decision := 'in_progress';
    end if;

    attempt_id := v_reservation.flow_payment_attempt_id;
    commerce_order := v_reservation.commerce_order;
    return next;
    return;
  end if;

  if v_reservation.flow_payment_status = 'ambiguous' then
    decision := 'ambiguous';
    attempt_id := v_reservation.flow_payment_attempt_id;
    commerce_order := v_reservation.commerce_order;
    return next;
    return;
  end if;

  if v_reservation.flow_payment_status not in ('not_started', 'failed') then
    decision := 'invalid_state';
    return next;
    return;
  end if;

  v_attempt_id := gen_random_uuid();
  v_commerce_order := coalesce(
    v_reservation.commerce_order,
    'sincro-' || replace(v_reservation.id::text, '-', '')
  );

  update public.reservations as r
  set
    commerce_order = v_commerce_order,
    flow_order = null,
    flow_checkout_url = null,
    flow_payment_status = 'creating',
    flow_payment_attempt_id = v_attempt_id,
    flow_payment_started_at = v_now,
    updated_at = v_now
  where r.id = p_reservation_id;

  decision := 'create';
  attempt_id := v_attempt_id;
  commerce_order := v_commerce_order;
  checkout_url := null;
  customer_email := v_reservation.customer_email;
  return next;
end;
$$;

create or replace function public.complete_flow_payment(
  p_reservation_id uuid,
  p_attempt_id uuid,
  p_flow_order text,
  p_checkout_url text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation public.reservations%rowtype;
begin
  if p_flow_order is null
     or btrim(p_flow_order) = ''
     or p_checkout_url is null
     or p_checkout_url !~ '^https://[^[:space:]]+$' then
    return false;
  end if;

  select r.*
  into v_reservation
  from public.reservations as r
  where r.id = p_reservation_id
  for update;

  if not found or v_reservation.flow_payment_attempt_id is distinct from p_attempt_id then
    return false;
  end if;

  if v_reservation.flow_payment_status = 'created' then
    return v_reservation.flow_order = p_flow_order
       and v_reservation.flow_checkout_url = p_checkout_url;
  end if;

  if v_reservation.flow_payment_status not in ('creating', 'ambiguous') then
    return false;
  end if;

  update public.reservations as r
  set
    flow_order = btrim(p_flow_order),
    flow_checkout_url = p_checkout_url,
    flow_payment_status = 'created',
    updated_at = clock_timestamp()
  where r.id = p_reservation_id;

  return true;
end;
$$;

create or replace function public.fail_flow_payment(
  p_reservation_id uuid,
  p_attempt_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation public.reservations%rowtype;
begin
  select r.*
  into v_reservation
  from public.reservations as r
  where r.id = p_reservation_id
  for update;

  if not found or v_reservation.flow_payment_attempt_id is distinct from p_attempt_id then
    return false;
  end if;

  if v_reservation.flow_payment_status = 'failed' then
    return true;
  end if;

  if v_reservation.flow_payment_status <> 'creating' then
    return false;
  end if;

  update public.reservations as r
  set
    flow_order = null,
    flow_checkout_url = null,
    flow_payment_status = 'failed',
    updated_at = clock_timestamp()
  where r.id = p_reservation_id;

  return true;
end;
$$;

create or replace function public.mark_flow_payment_ambiguous(
  p_reservation_id uuid,
  p_attempt_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation public.reservations%rowtype;
begin
  select r.*
  into v_reservation
  from public.reservations as r
  where r.id = p_reservation_id
  for update;

  if not found or v_reservation.flow_payment_attempt_id is distinct from p_attempt_id then
    return false;
  end if;

  if v_reservation.flow_payment_status = 'ambiguous' then
    return true;
  end if;

  if v_reservation.flow_payment_status <> 'creating' then
    return false;
  end if;

  update public.reservations as r
  set
    flow_payment_status = 'ambiguous',
    updated_at = clock_timestamp()
  where r.id = p_reservation_id;

  return true;
end;
$$;

revoke all on function public.claim_flow_payment(uuid) from public;
revoke all on function public.complete_flow_payment(uuid, uuid, text, text) from public;
revoke all on function public.fail_flow_payment(uuid, uuid) from public;
revoke all on function public.mark_flow_payment_ambiguous(uuid, uuid) from public;

revoke all on function public.claim_flow_payment(uuid) from anon, authenticated;
revoke all on function public.complete_flow_payment(uuid, uuid, text, text) from anon, authenticated;
revoke all on function public.fail_flow_payment(uuid, uuid) from anon, authenticated;
revoke all on function public.mark_flow_payment_ambiguous(uuid, uuid) from anon, authenticated;

grant execute on function public.claim_flow_payment(uuid) to service_role;
grant execute on function public.complete_flow_payment(uuid, uuid, text, text) to service_role;
grant execute on function public.fail_flow_payment(uuid, uuid) to service_role;
grant execute on function public.mark_flow_payment_ambiguous(uuid, uuid) to service_role;

commit;

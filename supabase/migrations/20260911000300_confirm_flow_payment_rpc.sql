begin;

alter table public.reservations
  add constraint reservations_paid_needs_review_has_paid_at
  check (
    status <> 'paid_needs_review'::public.reservation_status
    or paid_at is not null
  );

create or replace function public.confirm_flow_payment(
  p_commerce_order text,
  p_flow_order text,
  p_amount integer,
  p_currency text
)
returns table (
  decision text,
  reservation_id uuid,
  reservation_status public.reservation_status
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation public.reservations%rowtype;
  v_now timestamptz := clock_timestamp();
  v_constraint_name text;
begin
  if p_commerce_order is null
     or p_commerce_order !~ '^[A-Za-z0-9_-]{1,255}$'
     or p_flow_order is null
     or p_flow_order !~ '^[1-9][0-9]{0,15}$'
     or p_amount <> 15000
     or p_currency <> 'CLP' then
    decision := 'invalid_payment';
    return next;
    return;
  end if;

  select r.*
  into v_reservation
  from public.reservations as r
  where r.commerce_order = p_commerce_order
  for update;

  if not found then
    decision := 'not_found';
    return next;
    return;
  end if;

  reservation_id := v_reservation.id;
  reservation_status := v_reservation.status;

  if v_reservation.commerce_order <> p_commerce_order then
    decision := 'identity_mismatch';
    return next;
    return;
  end if;

  if v_reservation.amount <> 15000
     or v_reservation.amount <> p_amount then
    decision := 'amount_mismatch';
    return next;
    return;
  end if;

  if v_reservation.flow_order is not null
     and v_reservation.flow_order <> p_flow_order then
    decision := 'identity_mismatch';
    return next;
    return;
  end if;

  if v_reservation.flow_order is null then
    begin
      update public.reservations as r
      set
        flow_order = p_flow_order,
        flow_payment_status =
          'ambiguous'::public.flow_payment_creation_status,
        updated_at = v_now
      where r.id = v_reservation.id;

      v_reservation.flow_order := p_flow_order;
      v_reservation.flow_payment_status :=
        'ambiguous'::public.flow_payment_creation_status;
    exception
      when unique_violation then
        get stacked diagnostics
          v_constraint_name = constraint_name;

        if v_constraint_name <> 'reservations_flow_order_key' then
          raise;
        end if;

        if v_reservation.status in (
          'paid'::public.reservation_status,
          'confirmed'::public.reservation_status
        ) then
          decision := 'flow_order_conflict';
          return next;
          return;
        end if;

        update public.reservations as r
        set
          status = 'paid_needs_review'::public.reservation_status,
          paid_at = coalesce(r.paid_at, v_now),
          updated_at = v_now
        where r.id = v_reservation.id;

        decision := 'flow_order_conflict';
        reservation_status :=
          'paid_needs_review'::public.reservation_status;
        return next;
        return;
    end;
  end if;

  if v_reservation.status = 'paid'::public.reservation_status then
    decision := 'already_paid';
    reservation_status := 'paid'::public.reservation_status;
    return next;
    return;
  end if;

  if v_reservation.status = 'confirmed'::public.reservation_status then
    decision := 'already_confirmed';
    reservation_status := 'confirmed'::public.reservation_status;
    return next;
    return;
  end if;

  if v_reservation.status =
     'paid_needs_review'::public.reservation_status then
    decision := 'already_needs_review';
    reservation_status :=
      'paid_needs_review'::public.reservation_status;
    return next;
    return;
  end if;

  if v_reservation.status =
     'pending_payment'::public.reservation_status then
    update public.reservations as r
    set
      status = 'paid'::public.reservation_status,
      paid_at = coalesce(r.paid_at, v_now),
      updated_at = v_now
    where r.id = v_reservation.id;

    decision := 'paid';
    reservation_status := 'paid'::public.reservation_status;
    return next;
    return;
  end if;

  if v_reservation.status = 'expired'::public.reservation_status then
    begin
      update public.reservations as r
      set
        status = 'paid'::public.reservation_status,
        paid_at = coalesce(r.paid_at, v_now),
        updated_at = v_now
      where r.id = v_reservation.id;

      decision := 'late_payment_recovered';
      reservation_status := 'paid'::public.reservation_status;
    exception
      when exclusion_violation then
        get stacked diagnostics
          v_constraint_name = constraint_name;

        if v_constraint_name <> 'reservations_no_active_overlap' then
          raise;
        end if;

        update public.reservations as r
        set
          status = 'paid_needs_review'::public.reservation_status,
          paid_at = coalesce(r.paid_at, v_now),
          updated_at = v_now
        where r.id = v_reservation.id;

        decision := 'late_payment_slot_conflict';
        reservation_status :=
          'paid_needs_review'::public.reservation_status;
    end;

    return next;
    return;
  end if;

  update public.reservations as r
  set
    status = 'paid_needs_review'::public.reservation_status,
    paid_at = coalesce(r.paid_at, v_now),
    updated_at = v_now
  where r.id = v_reservation.id;

  decision := 'payment_requires_review';
  reservation_status :=
    'paid_needs_review'::public.reservation_status;
  return next;
end;
$$;

revoke all
  on function public.confirm_flow_payment(text, text, integer, text)
  from public;

revoke all
  on function public.confirm_flow_payment(text, text, integer, text)
  from anon, authenticated;

grant execute
  on function public.confirm_flow_payment(text, text, integer, text)
  to service_role;

commit;

begin;

create or replace function public.confirm_calendar_reservation(
  p_reservation_id uuid,
  p_google_event_id text,
  p_meet_url text
)
returns table (
  decision text,
  reservation_id uuid,
  reservation_status public.reservation_status
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_reservation public.reservations%rowtype;
  v_expected_event_id text;
  v_constraint_name text;
  v_now timestamptz := now();
begin
  if p_reservation_id is null
     or p_google_event_id is null
     or p_google_event_id = ''
     or p_meet_url is null
     or p_meet_url = ''
     or length(p_meet_url) > 2048
     or p_meet_url !~
       '^https://meet[.]google[.]com/[a-z0-9-]+([/?#][^[:space:]]*)?$'
  then
    return query
      select
        'invalid_input'::text,
        p_reservation_id,
        null::public.reservation_status;
    return;
  end if;

  select r.*
    into v_reservation
    from public.reservations as r
   where r.id = p_reservation_id
   for update;

  if not found then
    return query
      select
        'not_found'::text,
        p_reservation_id,
        null::public.reservation_status;
    return;
  end if;

  v_expected_event_id :=
    'sincro' || replace(lower(v_reservation.id::text), '-', '');

  if p_google_event_id <> v_expected_event_id then
    return query
      select
        'identity_mismatch'::text,
        v_reservation.id,
        v_reservation.status;
    return;
  end if;

  if v_reservation.status = 'confirmed'::public.reservation_status then
    if v_reservation.google_event_id = p_google_event_id
       and v_reservation.meet_url = p_meet_url
    then
      return query
        select
          'already_confirmed'::text,
          v_reservation.id,
          v_reservation.status;
    else
      return query
        select
          'confirmation_conflict'::text,
          v_reservation.id,
          v_reservation.status;
    end if;
    return;
  end if;

  if v_reservation.status =
     'paid_needs_review'::public.reservation_status
  then
    return query
      select
        'requires_review'::text,
        v_reservation.id,
        v_reservation.status;
    return;
  end if;

  if v_reservation.status <> 'paid'::public.reservation_status then
    return query
      select
        'invalid_status'::text,
        v_reservation.id,
        v_reservation.status;
    return;
  end if;

  if (
    v_reservation.google_event_id is not null
    and v_reservation.google_event_id <> p_google_event_id
  ) or (
    v_reservation.meet_url is not null
    and v_reservation.meet_url <> p_meet_url
  ) then
    return query
      select
        'calendar_metadata_conflict'::text,
        v_reservation.id,
        v_reservation.status;
    return;
  end if;

  begin
    update public.reservations as r
       set status = 'confirmed'::public.reservation_status,
           google_event_id = p_google_event_id,
           meet_url = p_meet_url,
           confirmed_at = coalesce(r.confirmed_at, v_now),
           updated_at = v_now
     where r.id = v_reservation.id;
  exception
    when unique_violation then
      get stacked diagnostics
        v_constraint_name = constraint_name;

      if v_constraint_name = 'reservations_google_event_id_key' then
        return query
          select
            'google_event_conflict'::text,
            v_reservation.id,
            v_reservation.status;
        return;
      end if;

      raise;
  end;

  return query
    select
      'confirmed'::text,
      v_reservation.id,
      'confirmed'::public.reservation_status;
end;
$function$;

revoke all
on function public.confirm_calendar_reservation(uuid, text, text)
from public;

revoke all
on function public.confirm_calendar_reservation(uuid, text, text)
from anon;

revoke all
on function public.confirm_calendar_reservation(uuid, text, text)
from authenticated;

grant execute
on function public.confirm_calendar_reservation(uuid, text, text)
to service_role;

create or replace function public.mark_calendar_reservation_for_review(
  p_reservation_id uuid
)
returns table (
  decision text,
  reservation_id uuid,
  reservation_status public.reservation_status
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_reservation public.reservations%rowtype;
  v_now timestamptz := now();
begin
  if p_reservation_id is null then
    return query
      select
        'invalid_input'::text,
        p_reservation_id,
        null::public.reservation_status;
    return;
  end if;

  select r.*
    into v_reservation
    from public.reservations as r
   where r.id = p_reservation_id
   for update;

  if not found then
    return query
      select
        'not_found'::text,
        p_reservation_id,
        null::public.reservation_status;
    return;
  end if;

  if v_reservation.status =
     'paid_needs_review'::public.reservation_status
  then
    return query
      select
        'already_needs_review'::text,
        v_reservation.id,
        v_reservation.status;
    return;
  end if;

  if v_reservation.status = 'confirmed'::public.reservation_status then
    return query
      select
        'already_confirmed'::text,
        v_reservation.id,
        v_reservation.status;
    return;
  end if;

  if v_reservation.status <> 'paid'::public.reservation_status then
    return query
      select
        'invalid_status'::text,
        v_reservation.id,
        v_reservation.status;
    return;
  end if;

  update public.reservations as r
     set status = 'paid_needs_review'::public.reservation_status,
         paid_at = coalesce(r.paid_at, v_now),
         updated_at = v_now
   where r.id = v_reservation.id;

  return query
    select
      'marked_for_review'::text,
      v_reservation.id,
      'paid_needs_review'::public.reservation_status;
end;
$function$;

revoke all
on function public.mark_calendar_reservation_for_review(uuid)
from public;

revoke all
on function public.mark_calendar_reservation_for_review(uuid)
from anon;

revoke all
on function public.mark_calendar_reservation_for_review(uuid)
from authenticated;

grant execute
on function public.mark_calendar_reservation_for_review(uuid)
to service_role;

commit;

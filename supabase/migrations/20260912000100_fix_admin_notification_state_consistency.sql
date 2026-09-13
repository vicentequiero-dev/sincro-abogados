begin;

create or replace function public.claim_admin_reservation_notification(
  p_reservation_id uuid,
  p_recipient text,
  p_sender text
)
returns table (
  decision text,
  reservation_id uuid,
  attempt_id uuid,
  idempotency_key text,
  recipient text,
  sender text,
  customer_name text,
  customer_email text,
  customer_phone text,
  practice_area text,
  start_at timestamptz,
  end_at timestamptz,
  meet_url text
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_notification public.reservation_admin_notifications%rowtype;
  v_reservation_status public.reservation_status;
  v_recipient text := lower(btrim(p_recipient));
  v_sender text := btrim(p_sender);
  v_attempt_id uuid;
  v_now timestamptz := now();
begin
  if p_reservation_id is null
     or p_recipient is null
     or p_sender is null
     or v_recipient = ''
     or length(v_recipient) not between 3 and 254
     or v_recipient !~
       '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
     or v_sender = ''
     or length(v_sender) not between 3 and 320
     or v_sender ~ '[[:cntrl:]]'
     or not (
       v_sender ~
         '^[^[:space:]<>@]+@[^[:space:]<>@]+[.][^[:space:]<>@]+$'
       or v_sender ~
         '^[^<>]{1,200} <[^[:space:]<>@]+@[^[:space:]<>@]+[.][^[:space:]<>@]+>$'
     )
  then
    return query
      select
        'invalid_input'::text,
        p_reservation_id,
        null::uuid,
        null::text,
        null::text,
        null::text,
        null::text,
        null::text,
        null::text,
        null::text,
        null::timestamptz,
        null::timestamptz,
        null::text;
    return;
  end if;

  select n.*
    into v_notification
    from public.reservation_admin_notifications as n
   where n.reservation_id = p_reservation_id
   for update;

  if not found then
    return query
      select
        'not_found'::text,
        p_reservation_id,
        null::uuid,
        null::text,
        null::text,
        null::text,
        null::text,
        null::text,
        null::text,
        null::text,
        null::timestamptz,
        null::timestamptz,
        null::text;
    return;
  end if;

  if v_notification.delivery_status = 'sent' then
    return query
      select
        'already_sent'::text,
        v_notification.reservation_id,
        null::uuid,
        v_notification.idempotency_key,
        v_notification.recipient,
        v_notification.sender,
        null::text,
        null::text,
        null::text,
        null::text,
        null::timestamptz,
        null::timestamptz,
        null::text;
    return;
  end if;

  if v_notification.delivery_status = 'manual_review' then
    return query
      select
        'manual_review'::text,
        v_notification.reservation_id,
        null::uuid,
        v_notification.idempotency_key,
        v_notification.recipient,
        v_notification.sender,
        null::text,
        null::text,
        null::text,
        null::text,
        null::timestamptz,
        null::timestamptz,
        null::text;
    return;
  end if;

  if v_notification.recipient is not null
     and v_notification.recipient <> v_recipient
  then
    if v_notification.delivery_status in (
      'sending',
      'ambiguous',
      'failed'
    ) then
      update public.reservation_admin_notifications as n
         set delivery_status = 'manual_review',
             next_attempt_at = null,
             updated_at = v_now
       where n.reservation_id = v_notification.reservation_id;
    end if;

    return query
      select
        'recipient_mismatch'::text,
        v_notification.reservation_id,
        null::uuid,
        v_notification.idempotency_key,
        v_notification.recipient,
        v_notification.sender,
        null::text,
        null::text,
        null::text,
        null::text,
        null::timestamptz,
        null::timestamptz,
        null::text;
    return;
  end if;

  if v_notification.sender is not null
     and v_notification.sender <> v_sender
  then
    if v_notification.delivery_status in (
      'sending',
      'ambiguous',
      'failed'
    ) then
      update public.reservation_admin_notifications as n
         set delivery_status = 'manual_review',
             next_attempt_at = null,
             updated_at = v_now
       where n.reservation_id = v_notification.reservation_id;
    end if;

    return query
      select
        'sender_mismatch'::text,
        v_notification.reservation_id,
        null::uuid,
        v_notification.idempotency_key,
        v_notification.recipient,
        v_notification.sender,
        null::text,
        null::text,
        null::text,
        null::text,
        null::timestamptz,
        null::timestamptz,
        null::text;
    return;
  end if;

  select r.status
    into v_reservation_status
    from public.reservations as r
   where r.id = v_notification.reservation_id;

  if not found then
    return query
      select
        'not_found'::text,
        v_notification.reservation_id,
        null::uuid,
        v_notification.idempotency_key,
        v_notification.recipient,
        v_notification.sender,
        null::text,
        null::text,
        null::text,
        null::text,
        null::timestamptz,
        null::timestamptz,
        null::text;
    return;
  end if;

  if v_reservation_status <> 'confirmed'::public.reservation_status then
    return query
      select
        'not_eligible'::text,
        v_notification.reservation_id,
        null::uuid,
        v_notification.idempotency_key,
        v_notification.recipient,
        v_notification.sender,
        null::text,
        null::text,
        null::text,
        null::text,
        null::timestamptz,
        null::timestamptz,
        null::text;
    return;
  end if;

  if v_notification.delivery_status in ('sending', 'ambiguous')
     and v_notification.first_attempt_at <= v_now - interval '24 hours'
  then
    update public.reservation_admin_notifications as n
       set delivery_status = 'manual_review',
           next_attempt_at = null,
           updated_at = v_now
     where n.reservation_id = v_notification.reservation_id;

    return query
      select
        'manual_review'::text,
        v_notification.reservation_id,
        null::uuid,
        v_notification.idempotency_key,
        coalesce(v_notification.recipient, v_recipient),
        coalesce(v_notification.sender, v_sender),
        null::text,
        null::text,
        null::text,
        null::text,
        null::timestamptz,
        null::timestamptz,
        null::text;
    return;
  end if;

  if v_notification.delivery_status in ('failed', 'ambiguous')
     and v_notification.next_attempt_at > v_now
  then
    return query
      select
        'retry_later'::text,
        v_notification.reservation_id,
        null::uuid,
        v_notification.idempotency_key,
        v_notification.recipient,
        v_notification.sender,
        null::text,
        null::text,
        null::text,
        null::text,
        null::timestamptz,
        null::timestamptz,
        null::text;
    return;
  end if;

  if v_notification.delivery_status = 'sending'
     and v_notification.attempt_started_at >
       v_now - interval '2 minutes'
  then
    return query
      select
        'in_progress'::text,
        v_notification.reservation_id,
        null::uuid,
        v_notification.idempotency_key,
        v_notification.recipient,
        v_notification.sender,
        null::text,
        null::text,
        null::text,
        null::text,
        null::timestamptz,
        null::timestamptz,
        null::text;
    return;
  end if;

  v_attempt_id := pg_catalog.gen_random_uuid();

  update public.reservation_admin_notifications as n
     set delivery_status = 'sending',
         recipient = coalesce(n.recipient, v_recipient),
         sender = coalesce(n.sender, v_sender),
         attempt_id = v_attempt_id,
         attempt_count = n.attempt_count + 1,
         first_attempt_at = coalesce(n.first_attempt_at, v_now),
         attempt_started_at = v_now,
         next_attempt_at = null,
         updated_at = v_now
   where n.reservation_id = v_notification.reservation_id;

  return query
    select
      'send'::text,
      v_notification.reservation_id,
      v_attempt_id,
      v_notification.idempotency_key,
      coalesce(v_notification.recipient, v_recipient),
      coalesce(v_notification.sender, v_sender),
      v_notification.customer_name,
      v_notification.customer_email,
      v_notification.customer_phone,
      v_notification.practice_area,
      v_notification.start_at,
      v_notification.end_at,
      v_notification.meet_url;
end;
$function$;

revoke all
on function public.claim_admin_reservation_notification(uuid, text, text)
from public;

revoke all
on function public.claim_admin_reservation_notification(uuid, text, text)
from anon;

revoke all
on function public.claim_admin_reservation_notification(uuid, text, text)
from authenticated;

revoke all
on function public.claim_admin_reservation_notification(uuid, text, text)
from service_role;

grant execute
on function public.claim_admin_reservation_notification(uuid, text, text)
to service_role;

commit;

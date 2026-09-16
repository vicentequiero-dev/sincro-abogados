begin;

create table public.reservation_admin_notifications (
  reservation_id uuid primary key
    references public.reservations(id) on delete cascade,
  delivery_status text not null default 'pending',
  idempotency_key text not null,
  customer_name text not null,
  customer_email text not null,
  customer_phone text not null,
  practice_area text not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  meet_url text not null,
  recipient text,
  sender text,
  attempt_id uuid,
  attempt_count integer not null default 0,
  failure_count integer not null default 0,
  first_attempt_at timestamptz,
  attempt_started_at timestamptz,
  next_attempt_at timestamptz,
  sent_at timestamptz,
  provider_message_id text,
  updated_at timestamptz not null default now(),

  constraint reservation_admin_notifications_status_check
    check (
      delivery_status in (
        'pending',
        'sending',
        'ambiguous',
        'failed',
        'sent',
        'manual_review'
      )
    ),
  constraint reservation_admin_notifications_idempotency_key_key
    unique (idempotency_key),
  constraint reservation_admin_notifications_idempotency_key_check
    check (
      idempotency_key =
        'sincro-admin-confirmed/' || lower(reservation_id::text)
      and length(idempotency_key) <= 256
    ),
  constraint reservation_admin_notifications_recipient_check
    check (
      recipient is null
      or (
        recipient = lower(btrim(recipient))
        and length(recipient) between 3 and 254
        and recipient ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
      )
    ),
  constraint reservation_admin_notifications_sender_check
    check (
      sender is null
      or (
        sender = btrim(sender)
        and length(sender) between 3 and 320
        and sender !~ '[[:cntrl:]]'
        and (
          sender ~
            '^[^[:space:]<>@]+@[^[:space:]<>@]+[.][^[:space:]<>@]+$'
          or sender ~
            '^[^<>]{1,200} <[^[:space:]<>@]+@[^[:space:]<>@]+[.][^[:space:]<>@]+>$'
        )
      )
    ),
  constraint reservation_admin_notifications_snapshot_check
    check (
      customer_name = btrim(customer_name)
      and length(customer_name) between 2 and 120
      and customer_name !~ '[[:cntrl:]]'
      and customer_email = lower(btrim(customer_email))
      and length(customer_email) between 3 and 254
      and customer_email ~
        '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
      and customer_phone = btrim(customer_phone)
      and length(customer_phone) between 7 and 30
      and customer_phone ~ '^[+0-9().[:space:]-]+$'
      and practice_area = btrim(practice_area)
      and length(practice_area) between 2 and 120
      and practice_area !~ '[[:cntrl:]]'
      and end_at = start_at + interval '30 minutes'
      and length(meet_url) between 1 and 2048
      and meet_url ~
        '^https://meet[.]google[.]com/[a-z0-9-]+([/?#][^[:space:]]*)?$'
    ),
  constraint reservation_admin_notifications_attempt_count_check
    check (
      attempt_count >= 0
      and failure_count between 0 and 4
      and failure_count <= attempt_count
    ),
  constraint reservation_admin_notifications_provider_message_id_key
    unique (provider_message_id),
  constraint reservation_admin_notifications_provider_message_id_check
    check (
      provider_message_id is null
      or (
        provider_message_id = btrim(provider_message_id)
        and length(provider_message_id) between 1 and 255
        and provider_message_id !~ '[[:cntrl:]]'
      )
    ),
  constraint reservation_admin_notifications_attempt_order_check
    check (
      first_attempt_at is null
      or (
        attempt_started_at is not null
        and attempt_started_at >= first_attempt_at
      )
    ),
  constraint reservation_admin_notifications_sent_order_check
    check (
      sent_at is null
      or (
        attempt_started_at is not null
        and sent_at >= attempt_started_at
      )
    ),
  constraint reservation_admin_notifications_retry_order_check
    check (
      next_attempt_at is null
      or (
        attempt_started_at is not null
        and next_attempt_at > attempt_started_at
      )
    ),
  constraint reservation_admin_notifications_updated_order_check
    check (
      (first_attempt_at is null or updated_at >= first_attempt_at)
      and (
        attempt_started_at is null
        or updated_at >= attempt_started_at
      )
      and (sent_at is null or updated_at >= sent_at)
    ),
  constraint reservation_admin_notifications_state_shape_check
    check (
      (
        delivery_status = 'pending'
        and recipient is null
        and sender is null
        and attempt_id is null
        and attempt_count = 0
        and failure_count = 0
        and first_attempt_at is null
        and attempt_started_at is null
        and next_attempt_at is null
        and sent_at is null
        and provider_message_id is null
      )
      or (
        delivery_status = 'sending'
        and recipient is not null
        and sender is not null
        and attempt_id is not null
        and attempt_count >= 1
        and failure_count >= 0
        and first_attempt_at is not null
        and attempt_started_at is not null
        and next_attempt_at is null
        and sent_at is null
        and provider_message_id is null
      )
      or (
        delivery_status in ('ambiguous', 'failed')
        and recipient is not null
        and sender is not null
        and attempt_id is not null
        and attempt_count >= 1
        and failure_count >= 0
        and first_attempt_at is not null
        and attempt_started_at is not null
        and next_attempt_at is not null
        and sent_at is null
        and provider_message_id is null
      )
      or (
        delivery_status = 'manual_review'
        and recipient is not null
        and sender is not null
        and attempt_id is not null
        and attempt_count >= 1
        and failure_count >= 0
        and first_attempt_at is not null
        and attempt_started_at is not null
        and next_attempt_at is null
        and sent_at is null
        and provider_message_id is null
      )
      or (
        delivery_status = 'sent'
        and recipient is not null
        and sender is not null
        and attempt_id is not null
        and attempt_count >= 1
        and failure_count >= 0
        and first_attempt_at is not null
        and attempt_started_at is not null
        and next_attempt_at is null
        and sent_at is not null
        and provider_message_id is not null
      )
    )
);

create index reservation_admin_notifications_pending_idx
  on public.reservation_admin_notifications (
    delivery_status,
    updated_at
  )
  where delivery_status <> 'sent';

alter table public.reservation_admin_notifications enable row level security;

revoke all
on table public.reservation_admin_notifications
from public;

revoke all
on table public.reservation_admin_notifications
from anon;

revoke all
on table public.reservation_admin_notifications
from authenticated;

revoke all
on table public.reservation_admin_notifications
from service_role;

create function public.enqueue_admin_reservation_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_should_enqueue boolean := false;
begin
  if new.status = 'confirmed'::public.reservation_status then
    if tg_op = 'INSERT' then
      v_should_enqueue := true;
    elsif tg_op = 'UPDATE' then
      v_should_enqueue := old.status is distinct from new.status;
    end if;
  end if;

  if v_should_enqueue then
    insert into public.reservation_admin_notifications (
      reservation_id,
      delivery_status,
      idempotency_key,
      customer_name,
      customer_email,
      customer_phone,
      practice_area,
      start_at,
      end_at,
      meet_url
    )
    values (
      new.id,
      'pending',
      'sincro-admin-confirmed/' || lower(new.id::text),
      btrim(new.customer_name),
      lower(btrim(new.customer_email)),
      btrim(new.customer_phone),
      btrim(new.practice_area),
      new.start_at,
      new.end_at,
      new.meet_url
    )
    on conflict (reservation_id) do nothing;
  end if;

  return new;
end;
$function$;

revoke all
on function public.enqueue_admin_reservation_notification()
from public;

revoke all
on function public.enqueue_admin_reservation_notification()
from anon;

revoke all
on function public.enqueue_admin_reservation_notification()
from authenticated;

revoke all
on function public.enqueue_admin_reservation_notification()
from service_role;

create trigger reservations_enqueue_admin_notification
after insert or update of status
on public.reservations
for each row
execute function public.enqueue_admin_reservation_notification();

create function public.protect_admin_reservation_notification_payload()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.reservation_id is distinct from old.reservation_id
     or new.idempotency_key is distinct from old.idempotency_key
     or new.customer_name is distinct from old.customer_name
     or new.customer_email is distinct from old.customer_email
     or new.customer_phone is distinct from old.customer_phone
     or new.practice_area is distinct from old.practice_area
     or new.start_at is distinct from old.start_at
     or new.end_at is distinct from old.end_at
     or new.meet_url is distinct from old.meet_url
  then
    raise exception 'admin notification payload is immutable'
      using errcode = '23514';
  end if;

  if old.recipient is not null
     and new.recipient is distinct from old.recipient
  then
    raise exception 'admin notification recipient is immutable'
      using errcode = '23514';
  end if;

  if old.sender is not null
     and new.sender is distinct from old.sender
  then
    raise exception 'admin notification sender is immutable'
      using errcode = '23514';
  end if;

  return new;
end;
$function$;

revoke all
on function public.protect_admin_reservation_notification_payload()
from public;

revoke all
on function public.protect_admin_reservation_notification_payload()
from anon;

revoke all
on function public.protect_admin_reservation_notification_payload()
from authenticated;

revoke all
on function public.protect_admin_reservation_notification_payload()
from service_role;

create trigger reservation_admin_notifications_protect_payload
before update
on public.reservation_admin_notifications
for each row
execute function public.protect_admin_reservation_notification_payload();

create function public.list_reconcilable_admin_notifications(
  p_limit integer
)
returns table (
  reservation_id uuid
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := now();
begin
  if p_limit is null or p_limit not between 1 and 20 then
    raise exception 'invalid limit'
      using errcode = '22023';
  end if;

  with stale_attempts as (
    select
      n.reservation_id,
      n.attempt_id
    from public.reservation_admin_notifications as n
    where n.delivery_status in ('sending', 'ambiguous')
      and n.first_attempt_at <= v_now - interval '24 hours'
    order by n.first_attempt_at asc, n.reservation_id asc
    limit 20
    for update skip locked
  )
  update public.reservation_admin_notifications as n
     set delivery_status = 'manual_review',
         next_attempt_at = null,
         updated_at = v_now
    from stale_attempts as s
   where n.reservation_id = s.reservation_id
     and n.attempt_id = s.attempt_id;

  return query
    select n.reservation_id
      from public.reservation_admin_notifications as n
     where n.delivery_status = 'pending'
        or (
          n.delivery_status = 'failed'
          and n.next_attempt_at <= v_now
        )
        or (
          n.delivery_status = 'ambiguous'
          and n.first_attempt_at > v_now - interval '24 hours'
          and n.next_attempt_at <= v_now
        )
        or (
          n.delivery_status = 'sending'
          and n.first_attempt_at > v_now - interval '24 hours'
          and n.attempt_started_at <= v_now - interval '2 minutes'
        )
     order by n.updated_at asc, n.reservation_id asc
     limit p_limit;
end;
$function$;

create function public.claim_admin_reservation_notification(
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

  if v_notification.recipient is not null
     and v_notification.recipient <> v_recipient
  then
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

create function public.complete_admin_reservation_notification(
  p_reservation_id uuid,
  p_attempt_id uuid,
  p_provider_message_id text
)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_notification public.reservation_admin_notifications%rowtype;
  v_provider_message_id text := btrim(p_provider_message_id);
  v_constraint_name text;
  v_now timestamptz := now();
begin
  if p_reservation_id is null
     or p_attempt_id is null
     or p_provider_message_id is null
     or v_provider_message_id = ''
     or length(v_provider_message_id) > 255
     or v_provider_message_id ~ '[[:cntrl:]]'
  then
    return 'invalid_input';
  end if;

  select n.*
    into v_notification
    from public.reservation_admin_notifications as n
   where n.reservation_id = p_reservation_id
   for update;

  if not found then
    return 'not_found';
  end if;

  if v_notification.delivery_status = 'sent' then
    if v_notification.attempt_id = p_attempt_id
       and v_notification.provider_message_id = v_provider_message_id
    then
      return 'already_sent';
    end if;
    return 'already_sent_different_result';
  end if;

  if v_notification.attempt_id is distinct from p_attempt_id then
    return 'attempt_mismatch';
  end if;

  if v_notification.delivery_status <> 'sending' then
    return 'invalid_state';
  end if;

  begin
    update public.reservation_admin_notifications as n
       set delivery_status = 'sent',
           sent_at = v_now,
           provider_message_id = v_provider_message_id,
           next_attempt_at = null,
           updated_at = v_now
     where n.reservation_id = v_notification.reservation_id;
  exception
    when unique_violation then
      get stacked diagnostics
        v_constraint_name = constraint_name;

      if v_constraint_name =
         'reservation_admin_notifications_provider_message_id_key'
      then
        return 'provider_message_conflict';
      end if;

      raise;
  end;

  return 'sent';
end;
$function$;

create function public.mark_admin_reservation_notification_ambiguous(
  p_reservation_id uuid,
  p_attempt_id uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_notification public.reservation_admin_notifications%rowtype;
  v_now timestamptz := now();
begin
  if p_reservation_id is null or p_attempt_id is null then
    return 'invalid_input';
  end if;

  select n.*
    into v_notification
    from public.reservation_admin_notifications as n
   where n.reservation_id = p_reservation_id
   for update;

  if not found then
    return 'not_found';
  end if;
  if v_notification.delivery_status = 'sent' then
    return 'already_sent';
  end if;
  if v_notification.attempt_id is distinct from p_attempt_id then
    return 'attempt_mismatch';
  end if;
  if v_notification.delivery_status <> 'sending' then
    return 'invalid_state';
  end if;

  update public.reservation_admin_notifications as n
     set delivery_status = 'ambiguous',
         next_attempt_at = v_now + interval '5 minutes',
         updated_at = v_now
   where n.reservation_id = v_notification.reservation_id;

  return 'ambiguous';
end;
$function$;

create function public.fail_admin_reservation_notification(
  p_reservation_id uuid,
  p_attempt_id uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_notification public.reservation_admin_notifications%rowtype;
  v_now timestamptz := now();
begin
  if p_reservation_id is null or p_attempt_id is null then
    return 'invalid_input';
  end if;

  select n.*
    into v_notification
    from public.reservation_admin_notifications as n
   where n.reservation_id = p_reservation_id
   for update;

  if not found then
    return 'not_found';
  end if;
  if v_notification.delivery_status = 'sent' then
    return 'already_sent';
  end if;
  if v_notification.attempt_id is distinct from p_attempt_id then
    return 'attempt_mismatch';
  end if;
  if v_notification.delivery_status <> 'sending' then
    return 'invalid_state';
  end if;

  if v_notification.failure_count >= 3 then
    update public.reservation_admin_notifications as n
       set delivery_status = 'manual_review',
           failure_count = n.failure_count + 1,
           next_attempt_at = null,
           updated_at = v_now
     where n.reservation_id = v_notification.reservation_id;

    return 'manual_review';
  end if;

  update public.reservation_admin_notifications as n
     set delivery_status = 'failed',
         failure_count = n.failure_count + 1,
         next_attempt_at = case v_notification.failure_count + 1
           when 1 then v_now + interval '5 minutes'
           when 2 then v_now + interval '15 minutes'
           else v_now + interval '1 hour'
         end,
         updated_at = v_now
   where n.reservation_id = v_notification.reservation_id;

  return 'failed';
end;
$function$;

create function public.mark_admin_reservation_notification_for_review(
  p_reservation_id uuid,
  p_attempt_id uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_notification public.reservation_admin_notifications%rowtype;
  v_now timestamptz := now();
begin
  if p_reservation_id is null or p_attempt_id is null then
    return 'invalid_input';
  end if;

  select n.*
    into v_notification
    from public.reservation_admin_notifications as n
   where n.reservation_id = p_reservation_id
   for update;

  if not found then
    return 'not_found';
  end if;
  if v_notification.delivery_status = 'sent' then
    return 'already_sent';
  end if;
  if v_notification.delivery_status = 'manual_review' then
    return 'already_manual_review';
  end if;
  if v_notification.attempt_id is distinct from p_attempt_id then
    return 'attempt_mismatch';
  end if;
  if v_notification.delivery_status not in (
    'sending',
    'ambiguous',
    'failed'
  ) then
    return 'invalid_state';
  end if;

  update public.reservation_admin_notifications as n
     set delivery_status = 'manual_review',
         next_attempt_at = null,
         updated_at = v_now
   where n.reservation_id = v_notification.reservation_id;

  return 'manual_review';
end;
$function$;

revoke all
on function public.list_reconcilable_admin_notifications(integer)
from public;

revoke all
on function public.list_reconcilable_admin_notifications(integer)
from anon;

revoke all
on function public.list_reconcilable_admin_notifications(integer)
from authenticated;

grant execute
on function public.list_reconcilable_admin_notifications(integer)
to service_role;

revoke all
on function public.claim_admin_reservation_notification(uuid, text, text)
from public;

revoke all
on function public.claim_admin_reservation_notification(uuid, text, text)
from anon;

revoke all
on function public.claim_admin_reservation_notification(uuid, text, text)
from authenticated;

grant execute
on function public.claim_admin_reservation_notification(uuid, text, text)
to service_role;

revoke all
on function public.complete_admin_reservation_notification(uuid, uuid, text)
from public;

revoke all
on function public.complete_admin_reservation_notification(uuid, uuid, text)
from anon;

revoke all
on function public.complete_admin_reservation_notification(uuid, uuid, text)
from authenticated;

grant execute
on function public.complete_admin_reservation_notification(uuid, uuid, text)
to service_role;

revoke all
on function public.mark_admin_reservation_notification_ambiguous(uuid, uuid)
from public;

revoke all
on function public.mark_admin_reservation_notification_ambiguous(uuid, uuid)
from anon;

revoke all
on function public.mark_admin_reservation_notification_ambiguous(uuid, uuid)
from authenticated;

grant execute
on function public.mark_admin_reservation_notification_ambiguous(uuid, uuid)
to service_role;

revoke all
on function public.fail_admin_reservation_notification(uuid, uuid)
from public;

revoke all
on function public.fail_admin_reservation_notification(uuid, uuid)
from anon;

revoke all
on function public.fail_admin_reservation_notification(uuid, uuid)
from authenticated;

grant execute
on function public.fail_admin_reservation_notification(uuid, uuid)
to service_role;

revoke all
on function public.mark_admin_reservation_notification_for_review(uuid, uuid)
from public;

revoke all
on function public.mark_admin_reservation_notification_for_review(uuid, uuid)
from anon;

revoke all
on function public.mark_admin_reservation_notification_for_review(uuid, uuid)
from authenticated;

grant execute
on function public.mark_admin_reservation_notification_for_review(uuid, uuid)
to service_role;

commit;

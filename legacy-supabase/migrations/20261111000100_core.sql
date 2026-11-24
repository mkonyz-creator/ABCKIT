-- =============================================================================
-- ABCkit – Core: roles, permissions, profiles, settings, numbering, audit
-- =============================================================================

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

-- ---------------------------------------------------------------------------
-- Utility: updated_at trigger
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Roles & permissions
-- ---------------------------------------------------------------------------
create table public.roles (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique check (key ~ '^[a-z_]+$'),
  name        text not null,
  description text,
  is_system   boolean not null default false,
  created_at  timestamptz not null default now()
);

create table public.permissions (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique check (key ~ '^[a-z_]+\.[a-z_]+$'),
  module      text not null,
  description text not null
);

create table public.role_permissions (
  role_id       uuid not null references public.roles(id) on delete cascade,
  permission_id uuid not null references public.permissions(id) on delete cascade,
  primary key (role_id, permission_id)
);

-- ---------------------------------------------------------------------------
-- Profiles (1:1 with auth.users)
-- ---------------------------------------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null default '' check (char_length(full_name) <= 200),
  email       text not null,
  phone       text check (phone is null or char_length(phone) <= 30),
  job_title   text,
  avatar_url  text,
  role_id     uuid not null references public.roles(id),
  is_active   boolean not null default false,
  last_seen_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index profiles_role_idx on public.profiles(role_id);
create trigger profiles_updated before update on public.profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Permission helpers (SECURITY DEFINER so they can read role tables under RLS)
-- ---------------------------------------------------------------------------
create or replace function public.current_role_key()
returns text language sql stable security definer set search_path = public as $$
  select r.key from profiles p join roles r on r.id = p.role_id
  where p.id = auth.uid() and p.is_active
$$;

create or replace function public.has_permission(perm text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from profiles p
    join roles r on r.id = p.role_id
    where p.id = auth.uid()
      and p.is_active
      and (
        r.key = 'super_admin'
        or exists (
          select 1 from role_permissions rp
          join permissions pm on pm.id = rp.permission_id
          where rp.role_id = r.id and pm.key = perm
        )
      )
  )
$$;

create or replace function public.is_active_user()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and is_active)
$$;

create or replace function public.my_permissions()
returns setof text language sql stable security definer set search_path = public as $$
  select pm.key
  from profiles p
  join roles r on r.id = p.role_id
  join permissions pm on (r.key = 'super_admin'
       or exists (select 1 from role_permissions rp where rp.role_id = r.id and rp.permission_id = pm.id))
  where p.id = auth.uid() and p.is_active
$$;

-- ---------------------------------------------------------------------------
-- Company settings (single row)
-- ---------------------------------------------------------------------------
create table public.company_settings (
  id                    int primary key default 1 check (id = 1),
  company_name          text not null default 'ARICOM BUILDING CONTRACTORS',
  logo_url              text,
  address               text default '',
  phone                 text default '',
  email                 text default '',
  website               text default '',
  tin                   text default '',
  default_currency      text not null default 'TZS' check (default_currency ~ '^[A-Z]{3}$'),
  currencies            jsonb not null default '[{"code":"TZS","name":"Tanzanian Shilling","rate":1},{"code":"USD","name":"US Dollar","rate":2500}]'::jsonb,
  taxes                 jsonb not null default '[{"name":"VAT","rate":18}]'::jsonb,
  units                 text[] not null default array['m','m²','m³','kg','tonne','No.','bag','litre','lm','item','sum','hr','day','trip','set','roll','sheet','pc'],
  financial_year_start_month int not null default 7 check (financial_year_start_month between 1 and 12),
  notification_settings jsonb not null default '{"low_stock":true,"task_assigned":true,"report_submitted":true,"approvals":true,"overdue_tasks":true}'::jsonb,
  updated_at            timestamptz not null default now()
);
insert into public.company_settings (id) values (1);
create trigger company_settings_updated before update on public.company_settings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Document / record numbering
-- ---------------------------------------------------------------------------
create table public.numbering_sequences (
  key        text primary key,
  label      text not null,
  prefix     text not null,
  next_value bigint not null default 1 check (next_value > 0),
  padding    int not null default 4 check (padding between 1 and 10),
  include_year boolean not null default true
);

insert into public.numbering_sequences (key, label, prefix) values
  ('project',          'Projects',               'PRJ'),
  ('boq',              'Bills of Quantities',    'BOQ'),
  ('site_report',      'Daily Site Reports',     'DSR'),
  ('purchase_request', 'Purchase Requests',      'PR'),
  ('purchase_order',   'Purchase Orders',        'PO'),
  ('goods_received',   'Goods Received Notes',   'GRN'),
  ('payment_voucher',  'Payment Vouchers',       'PV'),
  ('receipt',          'Receipts',               'RCT'),
  ('client_invoice',   'Client Invoices',        'INV'),
  ('employee',         'Employee Numbers',       'EMP'),
  ('equipment',        'Equipment IDs',          'EQ'),
  ('material',         'Material Codes',         'MAT');

create or replace function public.next_number(seq_key text)
returns text language plpgsql security definer set search_path = public as $$
declare
  s numbering_sequences%rowtype;
begin
  update numbering_sequences set next_value = next_value + 1
   where key = seq_key
   returning * into s;
  if not found then
    raise exception 'Unknown numbering sequence %', seq_key;
  end if;
  return s.prefix || '-' ||
         case when s.include_year then to_char(now(), 'YYYY') || '-' else '' end ||
         lpad((s.next_value - 1)::text, s.padding, '0');
end $$;

-- ---------------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------------
create table public.audit_logs (
  id          bigint generated always as identity primary key,
  table_name  text not null,
  record_id   text,
  action      text not null check (action in ('INSERT','UPDATE','DELETE')),
  old_data    jsonb,
  new_data    jsonb,
  changed_by  uuid references public.profiles(id) on delete set null,
  changed_at  timestamptz not null default now()
);
create index audit_logs_table_record_idx on public.audit_logs(table_name, record_id);
create index audit_logs_changed_at_idx on public.audit_logs(changed_at desc);
create index audit_logs_changed_by_idx on public.audit_logs(changed_by);

create or replace function public.audit_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  rec_id text;
  actor uuid := auth.uid();
begin
  if actor is not null and not exists (select 1 from profiles where id = actor) then
    actor := null;
  end if;
  if tg_op = 'DELETE' then
    rec_id := to_jsonb(old)->>'id';
    insert into audit_logs(table_name, record_id, action, old_data, changed_by)
      values (tg_table_name, rec_id, tg_op, to_jsonb(old), actor);
    return old;
  elsif tg_op = 'UPDATE' then
    if to_jsonb(new) = to_jsonb(old) then return new; end if;
    rec_id := to_jsonb(new)->>'id';
    insert into audit_logs(table_name, record_id, action, old_data, new_data, changed_by)
      values (tg_table_name, rec_id, tg_op, to_jsonb(old), to_jsonb(new), actor);
    return new;
  else
    rec_id := to_jsonb(new)->>'id';
    insert into audit_logs(table_name, record_id, action, new_data, changed_by)
      values (tg_table_name, rec_id, tg_op, to_jsonb(new), actor);
    return new;
  end if;
end $$;

-- Helper to attach audit trigger to a table
create or replace function public.enable_audit(tbl regclass)
returns void language plpgsql as $$
begin
  execute format('create trigger audit_%s after insert or update or delete on %s
                  for each row execute function public.audit_trigger()',
                 replace(tbl::text, 'public.', ''), tbl);
end $$;

select public.enable_audit('public.profiles');
select public.enable_audit('public.role_permissions');
select public.enable_audit('public.company_settings');
select public.enable_audit('public.numbering_sequences');

-- ---------------------------------------------------------------------------
-- Profile protection: only users.manage may change role / activation
-- ---------------------------------------------------------------------------
create or replace function public.guard_profile_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    return new; -- service role / migrations
  end if;
  if (new.role_id is distinct from old.role_id or new.is_active is distinct from old.is_active
      or new.email is distinct from old.email)
     and not public.has_permission('users.manage') then
    raise exception 'Not authorised to change role, status or email' using errcode = '42501';
  end if;
  if new.id = auth.uid() and new.is_active = false and old.is_active then
    raise exception 'You cannot deactivate your own account' using errcode = '42501';
  end if;
  -- the last active super admin can never be demoted/deactivated
  if old.role_id = (select id from roles where key = 'super_admin') and old.is_active
     and (new.role_id <> old.role_id or not new.is_active)
     and (select count(*) from profiles p join roles r on r.id = p.role_id
          where r.key = 'super_admin' and p.is_active) <= 1 then
    raise exception 'At least one active Super Administrator is required' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger profiles_guard before update on public.profiles
  for each row execute function public.guard_profile_update();

-- ---------------------------------------------------------------------------
-- New auth user → profile. The very first user becomes an active Super Admin;
-- everyone else is created as an inactive Employee until an admin activates them.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  first_user boolean;
  role_key text;
begin
  select not exists (select 1 from profiles) into first_user;
  role_key := case when first_user then 'super_admin'
                   else coalesce(nullif(new.raw_app_meta_data->>'role_key',''), 'employee') end;
  insert into profiles (id, email, full_name, role_id, is_active)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    coalesce((select id from roles where key = role_key), (select id from roles where key = 'employee')),
    first_user or coalesce((new.raw_app_meta_data->>'activated')::boolean, false)
  );
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------------
create table public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  title      text not null,
  body       text,
  type       text not null default 'info' check (type in ('info','success','warning','alert','task','approval')),
  link       text,
  is_read    boolean not null default false,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on public.notifications(user_id, is_read, created_at desc);

create or replace function public.notify_user(p_user uuid, p_title text, p_body text, p_type text, p_link text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_user is null then return; end if;
  insert into notifications(user_id, title, body, type, link)
  values (p_user, p_title, p_body, p_type, p_link);
end $$;

create or replace function public.notify_permission(p_perm text, p_title text, p_body text, p_type text, p_link text)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into notifications(user_id, title, body, type, link)
  select p.id, p_title, p_body, p_type, p_link
  from profiles p join roles r on r.id = p.role_id
  where p.is_active
    and p.id is distinct from auth.uid()
    and (r.key = 'super_admin' or exists (
      select 1 from role_permissions rp join permissions pm on pm.id = rp.permission_id
      where rp.role_id = r.id and pm.key = p_perm));
end $$;

create or replace function public.notification_enabled(setting text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((notification_settings->>setting)::boolean, true) from company_settings where id = 1
$$;

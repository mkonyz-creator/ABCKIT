-- =============================================================================
-- ABCkit – Clients, projects, project membership, BOQ
-- =============================================================================

create table public.clients (
  id             uuid primary key default gen_random_uuid(),
  name           text not null check (char_length(name) between 1 and 200),
  client_type    text not null default 'company' check (client_type in ('company','government','individual','ngo')),
  contact_person text,
  phone          text,
  email          text check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  address        text,
  tin            text,
  notes          text,
  is_demo        boolean not null default false,
  created_by     uuid references public.profiles(id) default auth.uid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index clients_name_trgm on public.clients using gin (name gin_trgm_ops);
create trigger clients_updated before update on public.clients for each row execute function public.set_updated_at();

create type public.project_status as enum ('planning','active','on_hold','completed','cancelled');

create table public.projects (
  id                 uuid primary key default gen_random_uuid(),
  code               text unique,
  name               text not null check (char_length(name) between 2 and 200),
  description        text,
  client_id          uuid references public.clients(id) on delete set null,
  location           text,
  region             text,
  latitude           numeric(9,6),
  longitude          numeric(9,6),
  start_date         date,
  end_date           date,
  contract_value     numeric(18,2) not null default 0 check (contract_value >= 0),
  budget             numeric(18,2) not null default 0 check (budget >= 0),
  currency           text not null default 'TZS' check (currency ~ '^[A-Z]{3}$'),
  status             public.project_status not null default 'planning',
  progress           numeric(5,2) not null default 0 check (progress between 0 and 100),
  project_manager_id uuid references public.profiles(id) on delete set null,
  cover_photo_path   text,
  is_archived        boolean not null default false,
  is_demo            boolean not null default false,
  created_by         uuid references public.profiles(id) default auth.uid(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint projects_dates_chk check (end_date is null or start_date is null or end_date >= start_date)
);
create index projects_status_idx on public.projects(status) where not is_archived;
create index projects_client_idx on public.projects(client_id);
create index projects_pm_idx on public.projects(project_manager_id);
create index projects_name_trgm on public.projects using gin (name gin_trgm_ops);
create trigger projects_updated before update on public.projects for each row execute function public.set_updated_at();

create or replace function public.projects_set_code()
returns trigger language plpgsql as $$
begin
  if new.code is null or new.code = '' then
    new.code := public.next_number('project');
  end if;
  return new;
end $$;
create trigger projects_code before insert on public.projects for each row execute function public.projects_set_code();

create table public.project_members (
  project_id   uuid not null references public.projects(id) on delete cascade,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  member_role  text not null default 'site_engineer'
               check (member_role in ('project_manager','site_engineer','quantity_surveyor','supervisor','storekeeper','member')),
  added_at     timestamptz not null default now(),
  primary key (project_id, user_id)
);
create index project_members_user_idx on public.project_members(user_id);

-- Access helper: global viewers, the PM, or listed members
create or replace function public.can_access_project(pid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select pid is null
      or public.has_permission('projects.view_all')
      or (public.is_active_user() and exists (
            select 1 from projects p where p.id = pid and p.project_manager_id = auth.uid()))
      or (public.is_active_user() and exists (
            select 1 from project_members m where m.project_id = pid and m.user_id = auth.uid()))
$$;

create or replace function public.my_project_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select id from projects where public.has_permission('projects.view_all')
  union
  select id from projects where project_manager_id = auth.uid() and public.is_active_user()
  union
  select project_id from project_members where user_id = auth.uid() and public.is_active_user()
$$;

-- ---------------------------------------------------------------------------
-- BOQ
-- ---------------------------------------------------------------------------
create table public.boqs (
  id          uuid primary key default gen_random_uuid(),
  number      text unique,
  project_id  uuid not null references public.projects(id) on delete cascade,
  title       text not null check (char_length(title) between 2 and 200),
  description text,
  currency    text not null default 'TZS' check (currency ~ '^[A-Z]{3}$'),
  taxes       jsonb not null default '[{"name":"VAT","rate":18}]'::jsonb
              check (jsonb_typeof(taxes) = 'array'),
  status      text not null default 'draft' check (status in ('draft','submitted','approved','superseded')),
  approved_by uuid references public.profiles(id),
  approved_at timestamptz,
  is_demo     boolean not null default false,
  created_by  uuid references public.profiles(id) default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index boqs_project_idx on public.boqs(project_id);
create trigger boqs_updated before update on public.boqs for each row execute function public.set_updated_at();

create or replace function public.boqs_before()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' and (new.number is null or new.number = '') then
    new.number := public.next_number('boq');
  end if;
  if tg_op = 'UPDATE' and new.status = 'approved' and old.status <> 'approved' then
    if not public.has_permission('boq.approve') then
      raise exception 'Not authorised to approve BOQs' using errcode = '42501';
    end if;
    new.approved_by := auth.uid();
    new.approved_at := now();
  end if;
  return new;
end $$;
create trigger boqs_before before insert or update on public.boqs for each row execute function public.boqs_before();

create table public.boq_sections (
  id         uuid primary key default gen_random_uuid(),
  boq_id     uuid not null references public.boqs(id) on delete cascade,
  code       text,
  title      text not null check (char_length(title) between 1 and 200),
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create index boq_sections_boq_idx on public.boq_sections(boq_id, sort_order);

create table public.boq_items (
  id          uuid primary key default gen_random_uuid(),
  boq_id      uuid not null references public.boqs(id) on delete cascade,
  section_id  uuid not null references public.boq_sections(id) on delete cascade,
  item_code   text,
  description text not null check (char_length(description) between 1 and 1000),
  unit        text not null default 'item',
  quantity    numeric(18,3) not null default 0 check (quantity >= 0),
  rate        numeric(18,2) not null default 0 check (rate >= 0),
  amount      numeric(20,2) generated always as (round(quantity * rate, 2)) stored,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index boq_items_section_idx on public.boq_items(section_id, sort_order);
create index boq_items_boq_idx on public.boq_items(boq_id);
create trigger boq_items_updated before update on public.boq_items for each row execute function public.set_updated_at();

-- keep boq_id consistent with the section
create or replace function public.boq_items_sync_boq()
returns trigger language plpgsql as $$
begin
  select boq_id into new.boq_id from public.boq_sections where id = new.section_id;
  return new;
end $$;
-- named "a_..." so it fires before the lock guard (triggers fire alphabetically)
create trigger a_boq_items_sync before insert or update of section_id on public.boq_items
  for each row execute function public.boq_items_sync_boq();

-- Approved BOQs are locked
create or replace function public.boq_lock_guard()
returns trigger language plpgsql as $$
declare
  b uuid := coalesce(new.boq_id, old.boq_id);
begin
  if exists (select 1 from public.boqs where id = b and status = 'approved') then
    raise exception 'This BOQ is approved and locked. Create a revision to change it.' using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;
create trigger boq_sections_lock before insert or update or delete on public.boq_sections
  for each row execute function public.boq_lock_guard();
create trigger boq_items_lock before insert or update or delete on public.boq_items
  for each row execute function public.boq_lock_guard();

-- Totals: Amount = Qty × Rate ; Grand Total = Subtotal + Σ taxes
create view public.boq_totals with (security_invoker = true) as
select
  b.id as boq_id,
  b.project_id,
  coalesce(sum(i.amount), 0)::numeric(20,2) as subtotal,
  (select coalesce(sum((t->>'rate')::numeric), 0) from jsonb_array_elements(b.taxes) t) as tax_rate_total,
  round(coalesce(sum(i.amount), 0) *
        (select coalesce(sum((t->>'rate')::numeric), 0) from jsonb_array_elements(b.taxes) t) / 100, 2) as tax_amount,
  round(coalesce(sum(i.amount), 0) *
        (1 + (select coalesce(sum((t->>'rate')::numeric), 0) from jsonb_array_elements(b.taxes) t) / 100), 2) as grand_total,
  count(i.id) as item_count
from public.boqs b
left join public.boq_items i on i.boq_id = b.id
group by b.id;

-- Duplicate a BOQ as a new draft revision
create or replace function public.duplicate_boq(p_boq uuid, p_title text default null)
returns uuid language plpgsql security invoker set search_path = public as $$
declare
  new_boq uuid;
  s record;
  new_section uuid;
begin
  insert into boqs (project_id, title, description, currency, taxes)
  select project_id, coalesce(p_title, title || ' (Revision)'), description, currency, taxes
  from boqs where id = p_boq
  returning id into new_boq;
  if new_boq is null then raise exception 'BOQ not found'; end if;

  for s in select * from boq_sections where boq_id = p_boq order by sort_order loop
    insert into boq_sections (boq_id, code, title, sort_order)
    values (new_boq, s.code, s.title, s.sort_order) returning id into new_section;
    insert into boq_items (boq_id, section_id, item_code, description, unit, quantity, rate, sort_order)
    select new_boq, new_section, item_code, description, unit, quantity, rate, sort_order
    from boq_items where section_id = s.id;
  end loop;
  return new_boq;
end $$;

select public.enable_audit('public.clients');
select public.enable_audit('public.projects');
select public.enable_audit('public.project_members');
select public.enable_audit('public.boqs');
select public.enable_audit('public.boq_sections');
select public.enable_audit('public.boq_items');

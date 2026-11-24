-- =============================================================================
-- ABCkit – Site reports, inventory, procurement, equipment
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Daily site reports
-- ---------------------------------------------------------------------------
create table public.site_reports (
  id                  uuid primary key default gen_random_uuid(),
  client_uuid         uuid unique,               -- idempotency key for offline sync
  number              text unique,
  project_id          uuid not null references public.projects(id) on delete cascade,
  report_date         date not null default current_date,
  engineer_id         uuid not null references public.profiles(id) default auth.uid(),
  weather             text check (weather in ('sunny','cloudy','rainy','heavy_rain','windy','stormy')),
  temperature_c       numeric(4,1),
  workers_count       int not null default 0 check (workers_count >= 0),
  labour              jsonb not null default '[]'::jsonb check (jsonb_typeof(labour) = 'array'),
  work_performed      text not null default '',
  materials_used      jsonb not null default '[]'::jsonb check (jsonb_typeof(materials_used) = 'array'),
  equipment_used      jsonb not null default '[]'::jsonb check (jsonb_typeof(equipment_used) = 'array'),
  progress_percent    numeric(5,2) check (progress_percent between 0 and 100),
  problems            text,
  safety_observations text,
  safety_incidents    int not null default 0 check (safety_incidents >= 0),
  recommendations     text,
  engineer_comments   text,
  signature_data      text check (signature_data is null or char_length(signature_data) < 400000),
  status              text not null default 'draft' check (status in ('draft','submitted','approved','rejected')),
  submitted_at        timestamptz,
  approved_by         uuid references public.profiles(id),
  approved_at         timestamptz,
  review_comment      text,
  is_demo             boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index site_reports_project_date_idx on public.site_reports(project_id, report_date desc);
create index site_reports_engineer_idx on public.site_reports(engineer_id);
create index site_reports_status_idx on public.site_reports(status);
create trigger site_reports_updated before update on public.site_reports for each row execute function public.set_updated_at();

create table public.site_report_photos (
  id           uuid primary key default gen_random_uuid(),
  report_id    uuid not null references public.site_reports(id) on delete cascade,
  storage_path text not null,
  caption      text,
  created_by   uuid references public.profiles(id) default auth.uid(),
  created_at   timestamptz not null default now()
);
create index site_report_photos_report_idx on public.site_report_photos(report_id);

create or replace function public.site_reports_before()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.number is null or new.number = '' then
      new.number := public.next_number('site_report');
    end if;
    if new.status in ('approved','rejected') then
      raise exception 'New reports cannot be created as approved/rejected';
    end if;
  end if;
  if new.status = 'submitted' and (tg_op = 'INSERT' or old.status <> 'submitted') then
    new.submitted_at := now();
  end if;
  if tg_op = 'UPDATE' then
    if old.status = 'approved' and not public.has_permission('site.approve') then
      raise exception 'Approved reports are locked' using errcode = '42501';
    end if;
    if new.status in ('approved','rejected') and new.status is distinct from old.status then
      if not public.has_permission('site.approve') then
        raise exception 'Not authorised to approve site reports' using errcode = '42501';
      end if;
      new.approved_by := auth.uid();
      new.approved_at := now();
    end if;
  end if;
  return new;
end $$;
create trigger site_reports_before before insert or update on public.site_reports
  for each row execute function public.site_reports_before();

-- When an approved report carries a progress figure, roll it onto the project
create or replace function public.site_reports_after()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  pname text;
begin
  select name into pname from projects where id = new.project_id;
  if new.status = 'approved' and (tg_op = 'INSERT' or old.status <> 'approved') then
    if new.progress_percent is not null then
      update projects set progress = new.progress_percent where id = new.project_id;
    end if;
    if notification_enabled('approvals') then
      perform notify_user(new.engineer_id, 'Site report approved',
        new.number || ' for ' || pname || ' was approved.', 'success', '/site-reports/' || new.id);
    end if;
  elsif new.status = 'rejected' and (tg_op = 'INSERT' or old.status <> 'rejected') then
    perform notify_user(new.engineer_id, 'Site report returned',
      new.number || ': ' || coalesce(new.review_comment, 'see comments'), 'warning', '/site-reports/' || new.id);
  elsif new.status = 'submitted' and (tg_op = 'INSERT' or old.status <> 'submitted') then
    if notification_enabled('report_submitted') then
      perform notify_user((select project_manager_id from projects where id = new.project_id),
        'Site report submitted', new.number || ' for ' || pname || ' awaits approval.', 'approval',
        '/site-reports/' || new.id);
    end if;
  end if;
  return new;
end $$;
create trigger site_reports_after after insert or update on public.site_reports
  for each row execute function public.site_reports_after();

create table public.safety_incidents (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects(id) on delete cascade,
  report_id     uuid references public.site_reports(id) on delete set null,
  incident_date date not null default current_date,
  severity      text not null default 'minor' check (severity in ('near_miss','minor','moderate','major','fatal')),
  category      text,
  description   text not null,
  persons_involved text,
  action_taken  text,
  status        text not null default 'open' check (status in ('open','investigating','closed')),
  reported_by   uuid references public.profiles(id) default auth.uid(),
  is_demo       boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index safety_incidents_project_idx on public.safety_incidents(project_id, incident_date desc);
create trigger safety_incidents_updated before update on public.safety_incidents for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Materials & inventory
-- ---------------------------------------------------------------------------
create table public.material_categories (
  id   uuid primary key default gen_random_uuid(),
  name text not null unique
);
insert into public.material_categories(name) values
  ('Cement & Binders'),('Aggregates'),('Steel & Reinforcement'),('Timber'),('Blocks & Bricks'),
  ('Roofing'),('Plumbing'),('Electrical'),('Finishes & Paint'),('Doors & Windows'),('Fuel & Lubricants'),('Consumables');

create table public.materials (
  id            uuid primary key default gen_random_uuid(),
  code          text unique,
  name          text not null check (char_length(name) between 1 and 200),
  category_id   uuid references public.material_categories(id) on delete set null,
  unit          text not null default 'No.',
  unit_price    numeric(18,2) not null default 0 check (unit_price >= 0),
  min_stock     numeric(18,3) not null default 0 check (min_stock >= 0),
  current_stock numeric(18,3) not null default 0,   -- maintained by inventory trigger only
  description   text,
  is_active     boolean not null default true,
  is_demo       boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index materials_category_idx on public.materials(category_id);
create index materials_name_trgm on public.materials using gin (name gin_trgm_ops);
create trigger materials_updated before update on public.materials for each row execute function public.set_updated_at();

create or replace function public.materials_before()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.code is null or new.code = '' then new.code := public.next_number('material'); end if;
    new.current_stock := 0;  -- opening stock must be entered as an inventory transaction
  elsif new.current_stock is distinct from old.current_stock
        and coalesce(current_setting('abckit.stock_update', true), '') <> 'on' then
    raise exception 'Stock balances can only change through inventory transactions' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger materials_before before insert or update on public.materials
  for each row execute function public.materials_before();

create table public.inventory_transactions (
  id               uuid primary key default gen_random_uuid(),
  material_id      uuid not null references public.materials(id) on delete restrict,
  project_id       uuid references public.projects(id) on delete set null,
  txn_type         text not null check (txn_type in ('receipt','issue','return','adjustment_in','adjustment_out','opening')),
  quantity         numeric(18,3) not null check (quantity > 0),
  unit_price       numeric(18,2) check (unit_price is null or unit_price >= 0),
  balance_after    numeric(18,3),
  reference        text,
  grn_item_id      uuid,
  notes            text,
  negative_override boolean not null default false,
  approved_by      uuid references public.profiles(id),
  transaction_date date not null default current_date,
  created_by       uuid references public.profiles(id) default auth.uid(),
  created_at       timestamptz not null default now()
);
create index inv_txn_material_idx on public.inventory_transactions(material_id, created_at desc);
create index inv_txn_project_idx on public.inventory_transactions(project_id);
create index inv_txn_date_idx on public.inventory_transactions(transaction_date);

create or replace function public.inventory_apply()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  m materials%rowtype;
  delta numeric;
begin
  select * into m from materials where id = new.material_id for update;
  if not found then raise exception 'Material not found'; end if;

  delta := case when new.txn_type in ('receipt','return','adjustment_in','opening') then new.quantity
                else -new.quantity end;

  if new.txn_type in ('adjustment_in','adjustment_out') and auth.uid() is not null
     and not has_permission('inventory.adjust') then
    raise exception 'Not authorised to post stock adjustments' using errcode = '42501';
  end if;

  if m.current_stock + delta < 0 then
    if not new.negative_override then
      raise exception 'Insufficient stock for %: available % %, requested % %',
        m.name, m.current_stock, m.unit, new.quantity, m.unit using errcode = 'P0001';
    end if;
    if auth.uid() is not null and not has_permission('inventory.approve_negative') then
      raise exception 'Negative stock requires authorised approval' using errcode = '42501';
    end if;
    new.approved_by := auth.uid();
  end if;

  if new.unit_price is null then new.unit_price := m.unit_price; end if;
  new.balance_after := m.current_stock + delta;

  perform set_config('abckit.stock_update', 'on', true);
  update materials set current_stock = new.balance_after,
         unit_price = case when new.txn_type = 'receipt' and new.unit_price > 0 then new.unit_price else unit_price end
   where id = m.id;
  perform set_config('abckit.stock_update', 'off', true);

  if new.balance_after <= m.min_stock and m.min_stock > 0 and m.current_stock > m.min_stock
     and notification_enabled('low_stock') then
    perform notify_permission('inventory.manage', 'Low stock: ' || m.name,
      'Balance ' || new.balance_after || ' ' || m.unit || ' is at/below minimum ' || m.min_stock || '.',
      'warning', '/inventory?tab=materials');
  end if;
  return new;
end $$;
create trigger inventory_apply before insert on public.inventory_transactions
  for each row execute function public.inventory_apply();

-- Ledger entries are immutable: corrections are made with adjustments
create or replace function public.immutable_row()
returns trigger language plpgsql as $$
begin
  raise exception '% records are immutable; post a correcting entry instead', tg_table_name using errcode = '42501';
end $$;
create trigger inventory_immutable before update or delete on public.inventory_transactions
  for each row execute function public.immutable_row();

-- ---------------------------------------------------------------------------
-- Suppliers & procurement
-- ---------------------------------------------------------------------------
create table public.suppliers (
  id             uuid primary key default gen_random_uuid(),
  name           text not null check (char_length(name) between 1 and 200),
  category       text,
  contact_person text,
  phone          text,
  email          text check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  address        text,
  tin            text,
  vrn            text,
  bank_details   text,
  payment_terms  text,
  rating         int check (rating between 1 and 5),
  is_active      boolean not null default true,
  notes          text,
  is_demo        boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index suppliers_name_trgm on public.suppliers using gin (name gin_trgm_ops);
create trigger suppliers_updated before update on public.suppliers for each row execute function public.set_updated_at();

create table public.purchase_requests (
  id            uuid primary key default gen_random_uuid(),
  number        text unique,
  project_id    uuid references public.projects(id) on delete set null,
  requested_by  uuid references public.profiles(id) default auth.uid(),
  needed_by     date,
  priority      text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  justification text,
  status        text not null default 'draft' check (status in ('draft','submitted','approved','rejected','ordered','cancelled')),
  approved_by   uuid references public.profiles(id),
  approved_at   timestamptz,
  review_comment text,
  is_demo       boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index purchase_requests_project_idx on public.purchase_requests(project_id);
create index purchase_requests_status_idx on public.purchase_requests(status);
create trigger purchase_requests_updated before update on public.purchase_requests for each row execute function public.set_updated_at();

create table public.purchase_request_items (
  id             uuid primary key default gen_random_uuid(),
  request_id     uuid not null references public.purchase_requests(id) on delete cascade,
  material_id    uuid references public.materials(id) on delete set null,
  description    text not null,
  quantity       numeric(18,3) not null check (quantity > 0),
  unit           text not null default 'No.',
  estimated_rate numeric(18,2) not null default 0 check (estimated_rate >= 0),
  amount         numeric(20,2) generated always as (round(quantity * estimated_rate, 2)) stored
);
create index pr_items_request_idx on public.purchase_request_items(request_id);

create table public.purchase_orders (
  id            uuid primary key default gen_random_uuid(),
  number        text unique,
  supplier_id   uuid not null references public.suppliers(id) on delete restrict,
  project_id    uuid references public.projects(id) on delete set null,
  request_id    uuid references public.purchase_requests(id) on delete set null,
  order_date    date not null default current_date,
  expected_date date,
  currency      text not null default 'TZS' check (currency ~ '^[A-Z]{3}$'),
  tax_rate      numeric(5,2) not null default 18 check (tax_rate between 0 and 100),
  delivery_address text,
  terms         text,
  notes         text,
  status        text not null default 'draft'
                check (status in ('draft','pending_approval','approved','sent','partially_received','received','cancelled')),
  approved_by   uuid references public.profiles(id),
  approved_at   timestamptz,
  is_demo       boolean not null default false,
  created_by    uuid references public.profiles(id) default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index purchase_orders_supplier_idx on public.purchase_orders(supplier_id);
create index purchase_orders_project_idx on public.purchase_orders(project_id);
create index purchase_orders_status_idx on public.purchase_orders(status);
create trigger purchase_orders_updated before update on public.purchase_orders for each row execute function public.set_updated_at();

create table public.purchase_order_items (
  id           uuid primary key default gen_random_uuid(),
  po_id        uuid not null references public.purchase_orders(id) on delete cascade,
  material_id  uuid references public.materials(id) on delete set null,
  description  text not null,
  quantity     numeric(18,3) not null check (quantity > 0),
  unit         text not null default 'No.',
  rate         numeric(18,2) not null default 0 check (rate >= 0),
  amount       numeric(20,2) generated always as (round(quantity * rate, 2)) stored,
  received_qty numeric(18,3) not null default 0 check (received_qty >= 0)
);
create index po_items_po_idx on public.purchase_order_items(po_id);

create view public.purchase_order_totals with (security_invoker = true) as
select po.id as po_id,
       coalesce(sum(i.amount),0)::numeric(20,2) as subtotal,
       round(coalesce(sum(i.amount),0) * po.tax_rate / 100, 2) as tax_amount,
       round(coalesce(sum(i.amount),0) * (1 + po.tax_rate / 100), 2) as total,
       coalesce(sum(i.quantity),0) as qty_ordered,
       coalesce(sum(i.received_qty),0) as qty_received
from public.purchase_orders po
left join public.purchase_order_items i on i.po_id = po.id
group by po.id;

-- Approval workflow guards
create or replace function public.purchase_requests_before()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' and (new.number is null or new.number = '') then
    new.number := public.next_number('purchase_request');
  end if;
  if tg_op = 'INSERT' and new.status not in ('draft','submitted') then
    raise exception 'New requests must be draft or submitted';
  end if;
  if tg_op = 'UPDATE' and new.status in ('approved','rejected') and new.status is distinct from old.status then
    if not public.has_permission('procurement.approve') then
      raise exception 'Not authorised to approve purchase requests' using errcode = '42501';
    end if;
    new.approved_by := auth.uid();
    new.approved_at := now();
  end if;
  return new;
end $$;
create trigger purchase_requests_before before insert or update on public.purchase_requests
  for each row execute function public.purchase_requests_before();

create or replace function public.purchase_requests_after()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'submitted' and (tg_op = 'INSERT' or old.status <> 'submitted') and notification_enabled('approvals') then
    perform notify_permission('procurement.approve', 'Purchase request ' || new.number,
      'A purchase request is awaiting approval.', 'approval', '/procurement?tab=requests');
  elsif tg_op = 'UPDATE' and new.status in ('approved','rejected') and old.status <> new.status then
    perform notify_user(new.requested_by, 'Purchase request ' || new.status,
      new.number || ' was ' || new.status || '.', case when new.status = 'approved' then 'success' else 'warning' end,
      '/procurement?tab=requests');
  end if;
  return new;
end $$;
create trigger purchase_requests_after after insert or update on public.purchase_requests
  for each row execute function public.purchase_requests_after();

create or replace function public.purchase_orders_before()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.number is null or new.number = '' then new.number := public.next_number('purchase_order'); end if;
    if new.status not in ('draft','pending_approval') then
      raise exception 'New purchase orders must start as draft or pending approval';
    end if;
  elsif new.status is distinct from old.status then
    if new.status = 'approved' and not public.has_permission('procurement.approve') then
      raise exception 'Not authorised to approve purchase orders' using errcode = '42501';
    end if;
    if new.status = 'sent' and old.status <> 'approved' then
      raise exception 'Only approved purchase orders can be sent';
    end if;
    if new.status = 'approved' then
      new.approved_by := auth.uid();
      new.approved_at := now();
    end if;
  end if;
  return new;
end $$;
create trigger purchase_orders_before before insert or update on public.purchase_orders
  for each row execute function public.purchase_orders_before();

create or replace function public.purchase_orders_after()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'pending_approval' and (tg_op = 'INSERT' or old.status <> 'pending_approval')
     and notification_enabled('approvals') then
    perform notify_permission('procurement.approve', 'PO ' || new.number || ' awaiting approval',
      'A purchase order needs approval.', 'approval', '/procurement?tab=orders');
  end if;
  return new;
end $$;
create trigger purchase_orders_after after insert or update on public.purchase_orders
  for each row execute function public.purchase_orders_after();

-- PO items can only change while the PO is draft / pending
create or replace function public.po_items_guard()
returns trigger language plpgsql as $$
declare st text;
begin
  select status into st from public.purchase_orders where id = coalesce(new.po_id, old.po_id);
  if st not in ('draft','pending_approval')
     and coalesce(current_setting('abckit.grn_update', true), '') <> 'on' then
    raise exception 'Purchase order items are locked once the PO is approved' using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;
create trigger po_items_guard before insert or update or delete on public.purchase_order_items
  for each row execute function public.po_items_guard();

-- Goods received notes
create table public.goods_received (
  id               uuid primary key default gen_random_uuid(),
  number           text unique,
  po_id            uuid references public.purchase_orders(id) on delete restrict,
  supplier_id      uuid not null references public.suppliers(id) on delete restrict,
  project_id       uuid references public.projects(id) on delete set null,
  received_date    date not null default current_date,
  delivery_note_no text,
  received_by      uuid references public.profiles(id) default auth.uid(),
  notes            text,
  is_demo          boolean not null default false,
  created_at       timestamptz not null default now()
);
create index goods_received_po_idx on public.goods_received(po_id);
create index goods_received_supplier_idx on public.goods_received(supplier_id);

create or replace function public.goods_received_before()
returns trigger language plpgsql as $$
declare st text;
begin
  if new.number is null or new.number = '' then new.number := public.next_number('goods_received'); end if;
  if new.po_id is not null then
    select status into st from public.purchase_orders where id = new.po_id;
    if st not in ('approved','sent','partially_received') then
      raise exception 'Goods can only be received against an approved purchase order';
    end if;
  end if;
  return new;
end $$;
create trigger goods_received_before before insert on public.goods_received
  for each row execute function public.goods_received_before();

create table public.goods_received_items (
  id                uuid primary key default gen_random_uuid(),
  grn_id            uuid not null references public.goods_received(id) on delete cascade,
  po_item_id        uuid references public.purchase_order_items(id) on delete restrict,
  material_id       uuid not null references public.materials(id) on delete restrict,
  quantity_received numeric(18,3) not null check (quantity_received > 0),
  quantity_rejected numeric(18,3) not null default 0 check (quantity_rejected >= 0),
  unit_price        numeric(18,2) not null default 0 check (unit_price >= 0),
  remarks           text
);
create index grn_items_grn_idx on public.goods_received_items(grn_id);

-- Receiving goods: post stock receipt + update PO received quantities/status
create or replace function public.grn_item_apply()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  g goods_received%rowtype;
  poi purchase_order_items%rowtype;
  total_ord numeric; total_rec numeric;
begin
  select * into g from goods_received where id = new.grn_id;

  if new.po_item_id is not null then
    select * into poi from purchase_order_items where id = new.po_item_id for update;
    if poi.received_qty + new.quantity_received > poi.quantity * 1.10 then
      raise exception 'Received quantity exceeds ordered quantity (+10%% tolerance) for %', poi.description;
    end if;
    perform set_config('abckit.grn_update', 'on', true);
    update purchase_order_items set received_qty = received_qty + new.quantity_received where id = poi.id;
    perform set_config('abckit.grn_update', 'off', true);
  end if;

  insert into inventory_transactions (material_id, project_id, txn_type, quantity, unit_price, reference, grn_item_id, transaction_date, notes)
  values (new.material_id, g.project_id, 'receipt', new.quantity_received, new.unit_price, g.number, new.id, g.received_date,
          'Received via ' || g.number);

  if g.po_id is not null then
    select coalesce(sum(quantity),0), coalesce(sum(received_qty),0) into total_ord, total_rec
      from purchase_order_items where po_id = g.po_id;
    update purchase_orders
       set status = case when total_rec >= total_ord then 'received' else 'partially_received' end
     where id = g.po_id;
  end if;
  return new;
end $$;
create trigger grn_item_apply after insert on public.goods_received_items
  for each row execute function public.grn_item_apply();
create trigger grn_items_immutable before update or delete on public.goods_received_items
  for each row execute function public.immutable_row();

-- Supplier invoices
create table public.supplier_invoices (
  id           uuid primary key default gen_random_uuid(),
  supplier_id  uuid not null references public.suppliers(id) on delete restrict,
  po_id        uuid references public.purchase_orders(id) on delete set null,
  project_id   uuid references public.projects(id) on delete set null,
  invoice_no   text not null,
  invoice_date date not null default current_date,
  due_date     date,
  amount       numeric(18,2) not null check (amount >= 0),
  tax_amount   numeric(18,2) not null default 0 check (tax_amount >= 0),
  total        numeric(18,2) generated always as (amount + tax_amount) stored,
  currency     text not null default 'TZS',
  status       text not null default 'unpaid' check (status in ('unpaid','partially_paid','paid','disputed','void')),
  attachment_path text,
  notes        text,
  is_demo      boolean not null default false,
  created_by   uuid references public.profiles(id) default auth.uid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (supplier_id, invoice_no)
);
create index supplier_invoices_supplier_idx on public.supplier_invoices(supplier_id);
create trigger supplier_invoices_updated before update on public.supplier_invoices for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Equipment & machinery
-- ---------------------------------------------------------------------------
create table public.equipment (
  id                 uuid primary key default gen_random_uuid(),
  code               text unique,
  name               text not null check (char_length(name) between 1 and 200),
  category           text not null default 'other'
                     check (category in ('earthmoving','lifting','concrete','transport','compaction','power','survey','small_tools','other')),
  make               text,
  model              text,
  serial_no          text,
  registration_no    text,
  year               int check (year between 1950 and 2100),
  ownership          text not null default 'owned' check (ownership in ('owned','hired','leased')),
  purchase_date      date,
  purchase_cost      numeric(18,2) check (purchase_cost >= 0),
  hourly_rate        numeric(18,2) not null default 0 check (hourly_rate >= 0),
  status             text not null default 'available'
                     check (status in ('available','in_use','maintenance','breakdown','retired')),
  current_project_id uuid references public.projects(id) on delete set null,
  meter_reading      numeric(12,1) not null default 0,
  service_interval_hours numeric(10,1),
  next_service_date  date,
  notes              text,
  is_demo            boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index equipment_project_idx on public.equipment(current_project_id);
create index equipment_status_idx on public.equipment(status);
create trigger equipment_updated before update on public.equipment for each row execute function public.set_updated_at();

create or replace function public.equipment_set_code()
returns trigger language plpgsql as $$
begin
  if new.code is null or new.code = '' then new.code := public.next_number('equipment'); end if;
  return new;
end $$;
create trigger equipment_code before insert on public.equipment for each row execute function public.equipment_set_code();

create table public.equipment_assignments (
  id           uuid primary key default gen_random_uuid(),
  equipment_id uuid not null references public.equipment(id) on delete cascade,
  project_id   uuid not null references public.projects(id) on delete cascade,
  start_date   date not null default current_date,
  end_date     date,
  notes        text,
  created_by   uuid references public.profiles(id) default auth.uid(),
  created_at   timestamptz not null default now(),
  check (end_date is null or end_date >= start_date)
);
create index equipment_assignments_eq_idx on public.equipment_assignments(equipment_id, start_date desc);

create or replace function public.equipment_assignment_apply()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.end_date is null then
    update equipment_assignments set end_date = new.start_date
     where equipment_id = new.equipment_id and end_date is null and id <> new.id;
    update equipment set current_project_id = new.project_id, status = 'in_use' where id = new.equipment_id;
  elsif tg_op = 'UPDATE' and old.end_date is null then
    update equipment set current_project_id = null, status = 'available'
     where id = new.equipment_id and current_project_id = new.project_id and status = 'in_use';
  end if;
  return new;
end $$;
create trigger equipment_assignment_apply after insert or update on public.equipment_assignments
  for each row execute function public.equipment_assignment_apply();

create table public.equipment_usage_logs (
  id            uuid primary key default gen_random_uuid(),
  equipment_id  uuid not null references public.equipment(id) on delete cascade,
  project_id    uuid references public.projects(id) on delete set null,
  usage_date    date not null default current_date,
  operator_name text,
  hours_operated numeric(6,2) not null default 0 check (hours_operated between 0 and 24),
  idle_hours    numeric(6,2) not null default 0 check (idle_hours between 0 and 24),
  fuel_litres   numeric(10,2) not null default 0 check (fuel_litres >= 0),
  fuel_cost     numeric(18,2) not null default 0 check (fuel_cost >= 0),
  meter_reading numeric(12,1),
  work_done     text,
  created_by    uuid references public.profiles(id) default auth.uid(),
  created_at    timestamptz not null default now()
);
create index equipment_usage_eq_idx on public.equipment_usage_logs(equipment_id, usage_date desc);
create index equipment_usage_project_idx on public.equipment_usage_logs(project_id);

create or replace function public.equipment_usage_apply()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.meter_reading is not null then
    update equipment set meter_reading = greatest(meter_reading, new.meter_reading) where id = new.equipment_id;
  end if;
  return new;
end $$;
create trigger equipment_usage_apply after insert on public.equipment_usage_logs
  for each row execute function public.equipment_usage_apply();

create table public.maintenance_records (
  id              uuid primary key default gen_random_uuid(),
  equipment_id    uuid not null references public.equipment(id) on delete cascade,
  maintenance_type text not null default 'scheduled' check (maintenance_type in ('scheduled','repair','breakdown','inspection')),
  scheduled_date  date,
  completed_date  date,
  description     text not null,
  vendor          text,
  cost            numeric(18,2) not null default 0 check (cost >= 0),
  downtime_hours  numeric(8,1) not null default 0 check (downtime_hours >= 0),
  meter_reading   numeric(12,1),
  status          text not null default 'scheduled' check (status in ('scheduled','in_progress','completed','cancelled')),
  is_demo         boolean not null default false,
  created_by      uuid references public.profiles(id) default auth.uid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index maintenance_eq_idx on public.maintenance_records(equipment_id, scheduled_date desc);
create trigger maintenance_updated before update on public.maintenance_records for each row execute function public.set_updated_at();

create or replace function public.maintenance_apply()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.maintenance_type = 'breakdown' and new.status in ('scheduled','in_progress') then
    update equipment set status = 'breakdown' where id = new.equipment_id;
  elsif new.status = 'in_progress' then
    update equipment set status = 'maintenance' where id = new.equipment_id;
  elsif new.status = 'completed' and (tg_op = 'INSERT' or old.status <> 'completed') then
    update equipment
       set status = case when current_project_id is not null then 'in_use' else 'available' end
     where id = new.equipment_id and status in ('maintenance','breakdown');
  end if;
  return new;
end $$;
create trigger maintenance_apply after insert or update on public.maintenance_records
  for each row execute function public.maintenance_apply();

select public.enable_audit('public.site_reports');
select public.enable_audit('public.safety_incidents');
select public.enable_audit('public.materials');
select public.enable_audit('public.inventory_transactions');
select public.enable_audit('public.suppliers');
select public.enable_audit('public.purchase_requests');
select public.enable_audit('public.purchase_request_items');
select public.enable_audit('public.purchase_orders');
select public.enable_audit('public.purchase_order_items');
select public.enable_audit('public.goods_received');
select public.enable_audit('public.goods_received_items');
select public.enable_audit('public.supplier_invoices');
select public.enable_audit('public.equipment');
select public.enable_audit('public.equipment_assignments');
select public.enable_audit('public.maintenance_records');

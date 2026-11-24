-- =============================================================================
-- ABCkit – Reporting views, dashboard RPCs, storage buckets & policies
-- All views use security_invoker so Row Level Security of the caller applies.
-- =============================================================================

create view public.client_invoice_balances with (security_invoker = true) as
select ci.*,
       coalesce((select sum(f.amount_base) from public.financial_transactions f
                 where f.client_invoice_id = ci.id and f.status = 'approved'), 0)::numeric(18,2) as paid,
       (ci.total - coalesce((select sum(f.amount_base) from public.financial_transactions f
                 where f.client_invoice_id = ci.id and f.status = 'approved'), 0))::numeric(18,2) as balance
from public.client_invoices ci;

create view public.supplier_invoice_balances with (security_invoker = true) as
select si.*,
       coalesce((select sum(f.amount_base) from public.financial_transactions f
                 where f.supplier_invoice_id = si.id and f.status = 'approved'), 0)::numeric(18,2) as paid,
       (si.total - coalesce((select sum(f.amount_base) from public.financial_transactions f
                 where f.supplier_invoice_id = si.id and f.status = 'approved'), 0))::numeric(18,2) as balance
from public.supplier_invoices si;

create view public.project_financials with (security_invoker = true) as
select p.id as project_id, p.code, p.name, p.status, p.progress, p.contract_value, p.budget, p.start_date, p.end_date,
       p.is_archived, p.is_demo,
       coalesce(e.expense, 0)::numeric(20,2)  as actual_cost,
       coalesce(i.income, 0)::numeric(20,2)   as income_received,
       coalesce(inv.invoiced, 0)::numeric(20,2) as invoiced,
       (coalesce(inv.invoiced, 0) - coalesce(inv.paid, 0))::numeric(20,2) as outstanding_receivable,
       (p.budget - coalesce(e.expense, 0))::numeric(20,2) as remaining_budget,
       case when p.budget > 0 then round(coalesce(e.expense, 0) / p.budget * 100, 1) else 0 end as budget_used_pct,
       coalesce(b.boq_total, 0)::numeric(20,2) as boq_total,
       (coalesce(i.income, 0) - coalesce(e.expense, 0))::numeric(20,2) as net_cash
from public.projects p
left join lateral (select sum(amount_base) expense from public.financial_transactions f
                   where f.project_id = p.id and f.direction = 'expense' and f.status = 'approved') e on true
left join lateral (select sum(amount_base) income from public.financial_transactions f
                   where f.project_id = p.id and f.direction = 'income' and f.status = 'approved') i on true
left join lateral (select sum(total) invoiced, sum(paid) paid from public.client_invoice_balances c
                   where c.project_id = p.id and c.status <> 'void') inv on true
left join lateral (select t.grand_total boq_total from public.boq_totals t join public.boqs bq on bq.id = t.boq_id
                   where t.project_id = p.id and bq.status <> 'superseded'
                   order by (bq.status = 'approved') desc, bq.updated_at desc limit 1) b on true;

-- Actual cost per category per project (budget-vs-actual breakdown)
create view public.project_cost_breakdown with (security_invoker = true) as
select project_id, category, sum(amount_base)::numeric(20,2) as amount, count(*) as txn_count
from public.financial_transactions
where direction = 'expense' and status = 'approved'
group by project_id, category;

create view public.material_consumption with (security_invoker = true) as
select t.project_id, t.material_id, m.name as material_name, m.unit,
       sum(case when t.txn_type = 'issue' then t.quantity when t.txn_type = 'return' then -t.quantity else 0 end) as qty_consumed,
       sum(case when t.txn_type = 'issue' then t.quantity * coalesce(t.unit_price,0)
                when t.txn_type = 'return' then -t.quantity * coalesce(t.unit_price,0) else 0 end)::numeric(20,2) as value_consumed
from public.inventory_transactions t
join public.materials m on m.id = t.material_id
where t.project_id is not null
group by t.project_id, t.material_id, m.name, m.unit;

create view public.supplier_performance with (security_invoker = true) as
select s.id as supplier_id, s.name, s.category, s.rating, s.is_active,
       count(distinct po.id) filter (where po.status not in ('draft','cancelled')) as orders,
       coalesce(sum(pt.total) filter (where po.status not in ('draft','cancelled')), 0)::numeric(20,2) as order_value,
       count(distinct po.id) filter (where po.status = 'received') as orders_completed,
       count(distinct g.po_id) filter (where po.expected_date is not null and g.first_received <= po.expected_date) as on_time_orders,
       count(distinct g.po_id) filter (where po.expected_date is not null) as orders_with_due_date,
       coalesce((select sum(balance) from public.supplier_invoice_balances b
                 where b.supplier_id = s.id and b.status not in ('void')), 0)::numeric(20,2) as outstanding_balance
from public.suppliers s
left join public.purchase_orders po on po.supplier_id = s.id
left join public.purchase_order_totals pt on pt.po_id = po.id
left join lateral (select gr.po_id, min(gr.received_date) first_received from public.goods_received gr
                   where gr.po_id = po.id group by gr.po_id) g on true
group by s.id;

create view public.equipment_utilization with (security_invoker = true) as
select e.id as equipment_id, e.code, e.name, e.category, e.status, e.ownership, e.current_project_id, e.hourly_rate,
       coalesce(u.hours, 0) as hours_30d,
       coalesce(u.idle, 0) as idle_hours_30d,
       coalesce(u.fuel, 0) as fuel_litres_30d,
       coalesce(u.fuel_cost, 0)::numeric(20,2) as fuel_cost_30d,
       coalesce(u.days, 0) as days_logged_30d,
       round(coalesce(u.hours, 0) / (30 * 8.0) * 100, 1) as utilization_pct,
       coalesce(m.cost, 0)::numeric(20,2) as maintenance_cost_total,
       coalesce(m.downtime, 0) as downtime_hours_total,
       coalesce(m.breakdowns, 0) as breakdowns_total
from public.equipment e
left join lateral (select sum(hours_operated) hours, sum(idle_hours) idle, sum(fuel_litres) fuel, sum(fuel_cost) fuel_cost,
                          count(distinct usage_date) days
                   from public.equipment_usage_logs l
                   where l.equipment_id = e.id and l.usage_date > current_date - 30) u on true
left join lateral (select sum(cost) cost, sum(downtime_hours) downtime,
                          count(*) filter (where maintenance_type = 'breakdown') breakdowns
                   from public.maintenance_records r where r.equipment_id = e.id and r.status <> 'cancelled') m on true;

-- ---------------------------------------------------------------------------
-- Dashboard summary (runs as caller => respects RLS and project access)
-- ---------------------------------------------------------------------------
create or replace function public.dashboard_summary()
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare
  result jsonb;
begin
  select jsonb_build_object(
    'projects', (select jsonb_build_object(
        'active',    count(*) filter (where status = 'active'),
        'completed', count(*) filter (where status = 'completed'),
        'pending',   count(*) filter (where status in ('planning','on_hold')),
        'on_hold',   count(*) filter (where status = 'on_hold'),
        'total',     count(*),
        'contract_value', coalesce(sum(contract_value) filter (where status <> 'cancelled'), 0),
        'budget',    coalesce(sum(budget) filter (where status <> 'cancelled'), 0),
        'avg_progress', coalesce(round(avg(progress) filter (where status = 'active'), 1), 0))
      from projects where not is_archived),
    'finance', case when has_permission('finance.view') then (select jsonb_build_object(
        'expenditure', coalesce(sum(actual_cost), 0),
        'income',      coalesce(sum(income_received), 0),
        'remaining_budget', coalesce(sum(remaining_budget) filter (where status <> 'cancelled'), 0),
        'receivable',  coalesce(sum(outstanding_receivable), 0),
        'payable',     (select coalesce(sum(balance), 0) from supplier_invoice_balances where status not in ('void','paid')),
        'pending_approvals', (select count(*) from financial_transactions where status = 'pending'))
      from project_financials where not is_archived) else null end,
    'inventory', case when has_permission('inventory.view') then jsonb_build_object(
        'low_stock_count', (select count(*) from materials where is_active and min_stock > 0 and current_stock <= min_stock),
        'low_stock', coalesce((select jsonb_agg(x) from (
            select id, name, unit, current_stock, min_stock from materials
            where is_active and min_stock > 0 and current_stock <= min_stock
            order by (current_stock / nullif(min_stock,0)) asc limit 6) x), '[]'::jsonb),
        'stock_value', (select coalesce(sum(current_stock * unit_price), 0) from materials where is_active))
      else null end,
    'workforce', case when has_permission('hr.view') then jsonb_build_object(
        'employees', (select count(*) from employees where status in ('active','on_leave')),
        'present_today', (select count(*) from attendance where work_date = current_date and status in ('present','late','half_day')),
        'absent_today', (select count(*) from attendance where work_date = current_date and status in ('absent','sick')),
        'on_leave', (select count(*) from employees where status = 'on_leave'))
      else null end,
    'progress', coalesce((select jsonb_agg(x) from (
        select id, code, name, progress, status, end_date from projects
        where not is_archived and status in ('active','on_hold','planning')
        order by status = 'active' desc, updated_at desc limit 8) x), '[]'::jsonb),
    'deadlines', coalesce((select jsonb_agg(x order by x.due) from (
        select 'task' as kind, t.id, t.title as label, t.due_date as due, t.priority, p.name as project, t.status
          from tasks t left join projects p on p.id = t.project_id
         where t.status <> 'done' and t.due_date is not null and t.due_date <= current_date + 21
        union all
        select 'project', p.id, p.name, p.end_date, 'high', p.code, p.status::text
          from projects p
         where not p.is_archived and p.status in ('active','planning','on_hold')
           and p.end_date is not null and p.end_date <= current_date + 45
        order by 4 limit 10) x), '[]'::jsonb),
    'tasks', (select jsonb_build_object(
        'open', count(*) filter (where status <> 'done'),
        'overdue', count(*) filter (where status <> 'done' and due_date < current_date),
        'mine', count(*) filter (where status <> 'done' and assigned_to = auth.uid()))
      from tasks),
    'site', case when has_permission('site.view') then jsonb_build_object(
        'pending_reports', (select count(*) from site_reports where status = 'submitted'),
        'reports_7d', (select count(*) from site_reports where report_date > current_date - 7),
        'open_incidents', (select count(*) from safety_incidents where status <> 'closed'))
      else null end
  ) into result;
  return result;
end $$;

create or replace function public.monthly_finance(p_months int default 12, p_project uuid default null)
returns table(month date, income numeric, expense numeric)
language sql stable security invoker set search_path = public as $$
  with months as (
    select generate_series(date_trunc('month', current_date) - make_interval(months => greatest(p_months,1) - 1),
                           date_trunc('month', current_date), interval '1 month')::date as month)
  select m.month,
         coalesce(sum(f.amount_base) filter (where f.direction = 'income'), 0) as income,
         coalesce(sum(f.amount_base) filter (where f.direction = 'expense'), 0) as expense
  from months m
  left join financial_transactions f
    on date_trunc('month', f.transaction_date) = m.month and f.status = 'approved'
   and (p_project is null or f.project_id = p_project)
  group by m.month order by m.month
$$;

create or replace function public.workforce_productivity(p_days int default 14, p_project uuid default null)
returns table(day date, present bigint, absent bigint, hours numeric, overtime numeric)
language sql stable security invoker set search_path = public as $$
  with days as (select generate_series(current_date - (greatest(p_days,1) - 1), current_date, interval '1 day')::date as day)
  select d.day,
         count(a.id) filter (where a.status in ('present','late','half_day')),
         count(a.id) filter (where a.status in ('absent','sick')),
         coalesce(sum(a.hours_worked), 0),
         coalesce(sum(a.overtime_hours), 0)
  from days d left join attendance a on a.work_date = d.day and (p_project is null or a.project_id = p_project)
  group by d.day order by d.day
$$;

-- Sanitised recent activity feed (no confidential tables, respects module permissions & project access)
create or replace function public.recent_activity(p_limit int default 15, p_project uuid default null)
returns table(id bigint, table_name text, action text, label text, project_id uuid, actor text, changed_at timestamptz)
language sql stable security definer set search_path = public as $$
  select a.id, a.table_name, a.action,
         coalesce(d->>'number', d->>'title', d->>'name', d->>'code', d->>'description', d->>'full_name', '') as label,
         nullif(d->>'project_id','')::uuid,
         coalesce(p.full_name, 'System'), a.changed_at
  from audit_logs a
  cross join lateral (select coalesce(a.new_data, a.old_data) as d) x
  left join profiles p on p.id = a.changed_by
  where is_active_user()
    and a.table_name in ('projects','boqs','site_reports','safety_incidents','materials','inventory_transactions',
                         'purchase_requests','purchase_orders','goods_received','equipment','maintenance_records',
                         'financial_transactions','client_invoices','supplier_invoices','documents','tasks','clients','suppliers')
    and case a.table_name
          when 'projects' then has_permission('projects.view')
          when 'clients' then has_permission('projects.view')
          when 'boqs' then has_permission('boq.view')
          when 'site_reports' then has_permission('site.view')
          when 'safety_incidents' then has_permission('site.view')
          when 'materials' then has_permission('inventory.view')
          when 'inventory_transactions' then has_permission('inventory.view')
          when 'equipment' then has_permission('equipment.view')
          when 'maintenance_records' then has_permission('equipment.view')
          when 'financial_transactions' then has_permission('finance.view')
          when 'client_invoices' then has_permission('finance.view')
          when 'supplier_invoices' then has_permission('finance.view') or has_permission('procurement.view')
          when 'documents' then has_permission('documents.view') and coalesce(d->>'access_level','project') = 'project'
          when 'tasks' then has_permission('tasks.view')
          else has_permission('procurement.view') end
    and (case when a.table_name = 'projects' then can_access_project((d->>'id')::uuid)
              else (d->>'project_id' is null or can_access_project((d->>'project_id')::uuid)) end)
    and (p_project is null or (d->>'project_id')::uuid = p_project
         or (a.table_name = 'projects' and (d->>'id')::uuid = p_project))
  order by a.changed_at desc
  limit least(greatest(p_limit, 1), 100)
$$;

-- ---------------------------------------------------------------------------
-- Storage
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('documents', 'documents', false, 52428800, array[
     'application/pdf','image/jpeg','image/png','image/webp','image/gif',
     'application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
     'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
     'application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation',
     'text/plain','text/csv','application/zip','application/x-zip-compressed',
     'image/vnd.dwg','application/acad','application/dxf','image/vnd.dxf','application/octet-stream']),
  ('site-photos', 'site-photos', false, 10485760, array['image/jpeg','image/png','image/webp','image/heic']),
  ('project-photos', 'project-photos', false, 10485760, array['image/jpeg','image/png','image/webp']),
  ('branding', 'branding', true, 2097152, array['image/png','image/jpeg','image/svg+xml','image/webp'])
on conflict (id) do nothing;

create or replace function public.try_uuid(p text)
returns uuid language plpgsql immutable as $$
begin
  return p::uuid;
exception when others then
  return null;
end $$;

-- documents/{project_id|general}/{document_id}/{file}
create policy "documents read" on storage.objects for select to authenticated
  using (bucket_id = 'documents' and exists (
    select 1 from public.document_versions v join public.documents d on d.id = v.document_id
    where v.storage_path = storage.objects.name));
create policy "documents upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'documents' and public.has_permission('documents.manage')
    and ((storage.foldername(name))[1] = 'general'
         or public.can_access_project(public.try_uuid((storage.foldername(name))[1]))
            and public.try_uuid((storage.foldername(name))[1]) is not null));

-- site-photos/{project_id}/{report_key}/{file}
create policy "site photos read" on storage.objects for select to authenticated
  using (bucket_id = 'site-photos' and public.has_permission('site.view')
         and public.try_uuid((storage.foldername(name))[1]) is not null
         and public.can_access_project(public.try_uuid((storage.foldername(name))[1])));
create policy "site photos upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'site-photos' and public.has_permission('site.report')
         and public.try_uuid((storage.foldername(name))[1]) is not null
         and public.can_access_project(public.try_uuid((storage.foldername(name))[1])));

-- project-photos/{project_id}/{file}
create policy "project photos read" on storage.objects for select to authenticated
  using (bucket_id = 'project-photos' and public.has_permission('projects.view')
         and public.try_uuid((storage.foldername(name))[1]) is not null
         and public.can_access_project(public.try_uuid((storage.foldername(name))[1])));
create policy "project photos upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'project-photos'
         and (public.has_permission('projects.manage') or public.has_permission('site.report'))
         and public.try_uuid((storage.foldername(name))[1]) is not null
         and public.can_access_project(public.try_uuid((storage.foldername(name))[1])));
create policy "project photos delete" on storage.objects for delete to authenticated
  using (bucket_id = 'project-photos' and public.has_permission('projects.manage')
         and public.can_access_project(public.try_uuid((storage.foldername(name))[1])));

create policy "branding write" on storage.objects for insert to authenticated
  with check (bucket_id = 'branding' and public.has_permission('settings.manage'));
create policy "branding update" on storage.objects for update to authenticated
  using (bucket_id = 'branding' and public.has_permission('settings.manage'));

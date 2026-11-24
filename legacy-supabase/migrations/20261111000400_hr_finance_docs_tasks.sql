-- =============================================================================
-- ABCkit – Workforce/HR, finance, documents, tasks
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Employees (non-confidential directory data)
-- ---------------------------------------------------------------------------
create table public.employees (
  id              uuid primary key default gen_random_uuid(),
  employee_no     text unique,
  full_name       text not null check (char_length(full_name) between 2 and 200),
  gender          text check (gender in ('male','female','other')),
  phone           text,
  email           text check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  position        text not null default 'Labourer',
  department      text not null default 'Site Operations'
                  check (department in ('Management','Site Operations','Engineering','Quantity Surveying','Finance','Procurement','Stores','Human Resources','Plant & Equipment','Administration')),
  trade           text,
  employment_type text not null default 'permanent' check (employment_type in ('permanent','contract','casual','intern')),
  hire_date       date,
  status          text not null default 'active' check (status in ('active','on_leave','suspended','terminated')),
  profile_id      uuid unique references public.profiles(id) on delete set null,
  emergency_contact text,
  is_demo         boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index employees_dept_idx on public.employees(department);
create index employees_name_trgm on public.employees using gin (full_name gin_trgm_ops);
create trigger employees_updated before update on public.employees for each row execute function public.set_updated_at();

create or replace function public.employees_set_no()
returns trigger language plpgsql as $$
begin
  if new.employee_no is null or new.employee_no = '' then new.employee_no := public.next_number('employee'); end if;
  return new;
end $$;
create trigger employees_no before insert on public.employees for each row execute function public.employees_set_no();

-- Confidential compensation data lives in its own table with stricter RLS
create table public.employee_compensation (
  employee_id     uuid primary key references public.employees(id) on delete cascade,
  pay_basis       text not null default 'monthly' check (pay_basis in ('monthly','daily','hourly')),
  basic_salary    numeric(18,2) not null default 0 check (basic_salary >= 0),
  daily_rate      numeric(18,2) not null default 0 check (daily_rate >= 0),
  overtime_rate   numeric(18,2) not null default 0 check (overtime_rate >= 0),
  allowances      numeric(18,2) not null default 0 check (allowances >= 0),
  bank_name       text,
  bank_account    text,
  nssf_no         text,
  tin             text,
  national_id     text,
  updated_at      timestamptz not null default now()
);
create trigger employee_compensation_updated before update on public.employee_compensation for each row execute function public.set_updated_at();

create table public.employee_assignments (
  id          uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  project_id  uuid not null references public.projects(id) on delete cascade,
  role        text,
  start_date  date not null default current_date,
  end_date    date,
  created_at  timestamptz not null default now(),
  check (end_date is null or end_date >= start_date)
);
create index employee_assignments_emp_idx on public.employee_assignments(employee_id);
create index employee_assignments_project_idx on public.employee_assignments(project_id);

create table public.attendance (
  id             uuid primary key default gen_random_uuid(),
  employee_id    uuid not null references public.employees(id) on delete cascade,
  project_id     uuid references public.projects(id) on delete set null,
  work_date      date not null default current_date,
  status         text not null default 'present' check (status in ('present','absent','late','half_day','leave','sick','off')),
  check_in       time,
  check_out      time,
  hours_worked   numeric(5,2) not null default 0 check (hours_worked between 0 and 24),
  overtime_hours numeric(5,2) not null default 0 check (overtime_hours between 0 and 16),
  task_description text,
  notes          text,
  recorded_by    uuid references public.profiles(id) default auth.uid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (employee_id, work_date)
);
create index attendance_date_idx on public.attendance(work_date desc);
create index attendance_project_idx on public.attendance(project_id, work_date);
create trigger attendance_updated before update on public.attendance for each row execute function public.set_updated_at();

create table public.leave_requests (
  id          uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  leave_type  text not null default 'annual' check (leave_type in ('annual','sick','maternity','paternity','compassionate','unpaid','other')),
  start_date  date not null,
  end_date    date not null,
  days        int generated always as ((end_date - start_date) + 1) stored,
  reason      text,
  status      text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  approved_by uuid references public.profiles(id),
  approved_at timestamptz,
  created_by  uuid references public.profiles(id) default auth.uid(),
  created_at  timestamptz not null default now(),
  check (end_date >= start_date)
);
create index leave_requests_emp_idx on public.leave_requests(employee_id);

create or replace function public.leave_before()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.status in ('approved','rejected') and new.status is distinct from old.status then
    if not public.has_permission('hr.manage') then
      raise exception 'Not authorised to approve leave' using errcode = '42501';
    end if;
    new.approved_by := auth.uid();
    new.approved_at := now();
  elsif tg_op = 'INSERT' and new.status <> 'pending' and not public.has_permission('hr.manage') then
    raise exception 'Leave requests must start as pending' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger leave_before before insert or update on public.leave_requests
  for each row execute function public.leave_before();

create table public.payroll_records (
  id             uuid primary key default gen_random_uuid(),
  employee_id    uuid not null references public.employees(id) on delete restrict,
  period_start   date not null,
  period_end     date not null,
  days_worked    numeric(5,1) not null default 0,
  overtime_hours numeric(6,2) not null default 0,
  basic_pay      numeric(18,2) not null default 0 check (basic_pay >= 0),
  overtime_pay   numeric(18,2) not null default 0 check (overtime_pay >= 0),
  allowances     numeric(18,2) not null default 0 check (allowances >= 0),
  deductions     numeric(18,2) not null default 0 check (deductions >= 0),
  gross_pay      numeric(18,2) generated always as (basic_pay + overtime_pay + allowances) stored,
  net_pay        numeric(18,2) generated always as (basic_pay + overtime_pay + allowances - deductions) stored,
  status         text not null default 'draft' check (status in ('draft','approved','paid','void')),
  paid_on        date,
  payment_ref    text,
  notes          text,
  created_by     uuid references public.profiles(id) default auth.uid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (period_end >= period_start),
  unique (employee_id, period_start, period_end)
);
create index payroll_period_idx on public.payroll_records(period_start, period_end);
create trigger payroll_updated before update on public.payroll_records for each row execute function public.set_updated_at();

-- Generate draft payroll from attendance for a period (HR confidential)
create or replace function public.generate_payroll(p_start date, p_end date)
returns int language plpgsql security invoker set search_path = public as $$
declare
  n int;
begin
  if not has_permission('hr.payroll') then
    raise exception 'Not authorised to run payroll' using errcode = '42501';
  end if;
  insert into payroll_records (employee_id, period_start, period_end, days_worked, overtime_hours, basic_pay, overtime_pay, allowances)
  select e.id, p_start, p_end,
         coalesce(a.days, 0), coalesce(a.ot, 0),
         case c.pay_basis
           when 'monthly' then c.basic_salary
           when 'daily'   then round(c.daily_rate * coalesce(a.days, 0), 2)
           else round(c.daily_rate / 8 * coalesce(a.hours, 0), 2) end,
         round(c.overtime_rate * coalesce(a.ot, 0), 2),
         c.allowances
  from employees e
  join employee_compensation c on c.employee_id = e.id
  left join lateral (
    select sum(case status when 'half_day' then 0.5 when 'present' then 1 when 'late' then 1 else 0 end) as days,
           sum(overtime_hours) as ot,
           sum(hours_worked) as hours
    from attendance where employee_id = e.id and work_date between p_start and p_end
  ) a on true
  where e.status in ('active','on_leave')
  on conflict (employee_id, period_start, period_end) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- Finance
-- ---------------------------------------------------------------------------
create table public.client_invoices (
  id           uuid primary key default gen_random_uuid(),
  number       text unique,
  project_id   uuid not null references public.projects(id) on delete restrict,
  client_id    uuid references public.clients(id) on delete set null,
  invoice_type text not null default 'interim_certificate' check (invoice_type in ('advance','interim_certificate','final_account','variation','retention_release','other')),
  invoice_date date not null default current_date,
  due_date     date,
  description  text,
  amount       numeric(18,2) not null check (amount >= 0),
  tax_amount   numeric(18,2) not null default 0 check (tax_amount >= 0),
  retention    numeric(18,2) not null default 0 check (retention >= 0),
  total        numeric(18,2) generated always as (amount + tax_amount - retention) stored,
  currency     text not null default 'TZS',
  status       text not null default 'issued' check (status in ('draft','issued','partially_paid','paid','void')),
  is_demo      boolean not null default false,
  created_by   uuid references public.profiles(id) default auth.uid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index client_invoices_project_idx on public.client_invoices(project_id);
create trigger client_invoices_updated before update on public.client_invoices for each row execute function public.set_updated_at();

create or replace function public.client_invoices_set_no()
returns trigger language plpgsql as $$
begin
  if new.number is null or new.number = '' then new.number := public.next_number('client_invoice'); end if;
  if new.client_id is null then select client_id into new.client_id from public.projects where id = new.project_id; end if;
  return new;
end $$;
create trigger client_invoices_no before insert on public.client_invoices for each row execute function public.client_invoices_set_no();

create table public.financial_transactions (
  id                  uuid primary key default gen_random_uuid(),
  number              text unique,
  project_id          uuid references public.projects(id) on delete restrict,
  direction           text not null check (direction in ('income','expense')),
  category            text not null check (category in (
                        'client_payment','advance_payment','other_income',
                        'material','labour','equipment','fuel','subcontractor','supplier_payment',
                        'petty_cash','transport','permits_fees','utilities','overhead','salaries','other_expense')),
  amount              numeric(18,2) not null check (amount > 0),
  currency            text not null default 'TZS' check (currency ~ '^[A-Z]{3}$'),
  exchange_rate       numeric(18,6) not null default 1 check (exchange_rate > 0),
  amount_base         numeric(20,2) generated always as (round(amount * exchange_rate, 2)) stored,
  transaction_date    date not null default current_date,
  payment_method      text not null default 'bank_transfer'
                      check (payment_method in ('cash','bank_transfer','cheque','mobile_money','card','other')),
  reference_no        text,
  payee_payer         text,
  description         text not null check (char_length(description) between 2 and 1000),
  client_id           uuid references public.clients(id) on delete set null,
  client_invoice_id   uuid references public.client_invoices(id) on delete set null,
  supplier_id         uuid references public.suppliers(id) on delete set null,
  supplier_invoice_id uuid references public.supplier_invoices(id) on delete set null,
  employee_id         uuid references public.employees(id) on delete set null,
  equipment_id        uuid references public.equipment(id) on delete set null,
  attachment_path     text,
  status              text not null default 'pending' check (status in ('pending','approved','rejected','void')),
  approved_by         uuid references public.profiles(id),
  approved_at         timestamptz,
  void_reason         text,
  is_demo             boolean not null default false,
  created_by          uuid references public.profiles(id) default auth.uid(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint fin_direction_category_chk check (
    (direction = 'income'  and category in ('client_payment','advance_payment','other_income')) or
    (direction = 'expense' and category not in ('client_payment','advance_payment','other_income')))
);
create index fin_project_idx on public.financial_transactions(project_id, transaction_date desc);
create index fin_date_idx on public.financial_transactions(transaction_date desc);
create index fin_status_idx on public.financial_transactions(status);
create index fin_supplier_invoice_idx on public.financial_transactions(supplier_invoice_id);
create index fin_client_invoice_idx on public.financial_transactions(client_invoice_id);
create trigger fin_updated before update on public.financial_transactions for each row execute function public.set_updated_at();

create or replace function public.financial_transactions_before()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.number is null or new.number = '' then
      new.number := public.next_number(case when new.direction = 'income' then 'receipt' else 'payment_voucher' end);
    end if;
    -- Only senior approvers may record a transaction as already approved (segregation of duties)
    if new.status <> 'pending' and (auth.uid() is not null)
       and coalesce(public.current_role_key(), '') not in ('super_admin','managing_director') then
      new.status := 'pending';
    end if;
    if new.status = 'approved' then new.approved_by := auth.uid(); new.approved_at := now(); end if;
  else
    if old.status in ('approved','void') then
      -- approved transactions may only be voided (with reason), never edited
      if new.status = 'void' and old.status = 'approved' then
        if not public.has_permission('finance.approve') then
          raise exception 'Not authorised to void transactions' using errcode = '42501';
        end if;
        if coalesce(trim(new.void_reason), '') = '' then
          raise exception 'A reason is required to void a transaction';
        end if;
        -- amount_base is a generated column (NULL in NEW during BEFORE triggers)
        if (to_jsonb(new) - 'status' - 'void_reason' - 'updated_at' - 'amount_base')
           is distinct from (to_jsonb(old) - 'status' - 'void_reason' - 'updated_at' - 'amount_base') then
          raise exception 'Only the status and void reason can change when voiding' using errcode = '42501';
        end if;
        return new;
      end if;
      raise exception 'Approved or void transactions cannot be edited' using errcode = '42501';
    end if;
    if new.status in ('approved','rejected') and new.status is distinct from old.status then
      if not public.has_permission('finance.approve') then
        raise exception 'Not authorised to approve transactions' using errcode = '42501';
      end if;
      if new.status = 'approved' and new.created_by = auth.uid() and public.current_role_key() not in ('super_admin','managing_director') then
        raise exception 'Segregation of duties: you cannot approve your own transaction' using errcode = '42501';
      end if;
      new.approved_by := auth.uid();
      new.approved_at := now();
    end if;
  end if;
  return new;
end $$;
create trigger fin_before before insert or update on public.financial_transactions
  for each row execute function public.financial_transactions_before();
create or replace function public.prevent_delete()
returns trigger language plpgsql as $$
begin
  raise exception '% records cannot be deleted; void them instead', tg_table_name using errcode = '42501';
end $$;
create trigger fin_no_delete before delete on public.financial_transactions
  for each row execute function public.prevent_delete();

-- Keep invoice statuses in sync with approved payments
create or replace function public.fin_after()
returns trigger language plpgsql security definer set search_path = public as $$
declare paid numeric; tot numeric;
begin
  if new.supplier_invoice_id is not null then
    select coalesce(sum(amount_base),0) into paid from financial_transactions
     where supplier_invoice_id = new.supplier_invoice_id and status = 'approved';
    select total into tot from supplier_invoices where id = new.supplier_invoice_id;
    update supplier_invoices set status = case when paid >= tot then 'paid' when paid > 0 then 'partially_paid' else 'unpaid' end
     where id = new.supplier_invoice_id and status not in ('void','disputed');
  end if;
  if new.client_invoice_id is not null then
    select coalesce(sum(amount_base),0) into paid from financial_transactions
     where client_invoice_id = new.client_invoice_id and status = 'approved';
    select total into tot from client_invoices where id = new.client_invoice_id;
    update client_invoices set status = case when paid >= tot then 'paid' when paid > 0 then 'partially_paid' else 'issued' end
     where id = new.client_invoice_id and status not in ('void','draft');
  end if;
  if new.status = 'pending' and tg_op = 'INSERT' and notification_enabled('approvals') then
    perform notify_permission('finance.approve', 'Transaction ' || new.number || ' awaiting approval',
      initcap(new.direction) || ' of ' || new.currency || ' ' || to_char(new.amount, 'FM999,999,999,990.00'),
      'approval', '/finance?tab=transactions');
  end if;
  return new;
end $$;
create trigger fin_after after insert or update on public.financial_transactions
  for each row execute function public.fin_after();

-- ---------------------------------------------------------------------------
-- Documents with version history
-- ---------------------------------------------------------------------------
create table public.documents (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid references public.projects(id) on delete cascade,
  title           text not null check (char_length(title) between 1 and 300),
  category        text not null default 'other'
                  check (category in ('contract','drawing','boq','invoice','receipt','site_report','permit','technical','photo','correspondence','other')),
  description     text,
  tags            text[] not null default '{}',
  access_level    text not null default 'project' check (access_level in ('project','management','restricted')),
  current_version int not null default 0,
  current_path    text,
  file_name       text,
  mime_type       text,
  size_bytes      bigint,
  is_demo         boolean not null default false,
  created_by      uuid references public.profiles(id) default auth.uid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index documents_project_idx on public.documents(project_id, category);
create index documents_title_trgm on public.documents using gin (title gin_trgm_ops);
create trigger documents_updated before update on public.documents for each row execute function public.set_updated_at();

create table public.document_versions (
  id           uuid primary key default gen_random_uuid(),
  document_id  uuid not null references public.documents(id) on delete cascade,
  version      int not null,
  storage_path text not null,
  file_name    text not null,
  mime_type    text,
  size_bytes   bigint check (size_bytes between 0 and 52428800),
  change_note  text,
  uploaded_by  uuid references public.profiles(id) default auth.uid(),
  created_at   timestamptz not null default now(),
  unique (document_id, version)
);

create or replace function public.document_version_before()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  select coalesce(max(version), 0) + 1 into new.version from document_versions where document_id = new.document_id;
  update documents set current_version = new.version, current_path = new.storage_path,
         file_name = new.file_name, mime_type = new.mime_type, size_bytes = new.size_bytes
   where id = new.document_id;
  return new;
end $$;
create trigger document_version_before before insert on public.document_versions
  for each row execute function public.document_version_before();

-- ---------------------------------------------------------------------------
-- Tasks & milestones
-- ---------------------------------------------------------------------------
create table public.tasks (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid references public.projects(id) on delete cascade,
  parent_id    uuid references public.tasks(id) on delete cascade,
  title        text not null check (char_length(title) between 2 and 300),
  description  text,
  assigned_to  uuid references public.profiles(id) on delete set null,
  priority     text not null default 'medium' check (priority in ('low','medium','high','critical')),
  status       text not null default 'todo' check (status in ('todo','in_progress','review','blocked','done')),
  start_date   date,
  due_date     date,
  completed_at timestamptz,
  progress     int not null default 0 check (progress between 0 and 100),
  is_milestone boolean not null default false,
  is_demo      boolean not null default false,
  created_by   uuid references public.profiles(id) default auth.uid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (due_date is null or start_date is null or due_date >= start_date)
);
create index tasks_project_idx on public.tasks(project_id, due_date);
create index tasks_assignee_idx on public.tasks(assigned_to, status);
create trigger tasks_updated before update on public.tasks for each row execute function public.set_updated_at();

create or replace function public.tasks_before()
returns trigger language plpgsql as $$
begin
  if new.status = 'done' then
    new.progress := 100;
    if tg_op = 'INSERT' or old.status <> 'done' then new.completed_at := now(); end if;
  else
    new.completed_at := null;
  end if;
  return new;
end $$;
create trigger tasks_before before insert or update on public.tasks for each row execute function public.tasks_before();

create or replace function public.tasks_after()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.assigned_to is not null and new.assigned_to is distinct from auth.uid()
     and (tg_op = 'INSERT' or old.assigned_to is distinct from new.assigned_to)
     and notification_enabled('task_assigned') then
    perform notify_user(new.assigned_to, 'New task assigned',
      new.title || coalesce(' — due ' || to_char(new.due_date, 'DD Mon YYYY'), ''), 'task', '/tasks?task=' || new.id);
  end if;
  return new;
end $$;
create trigger tasks_after after insert or update on public.tasks for each row execute function public.tasks_after();

-- Idempotent overdue-task reminder (call from pg_cron or the app once a day)
create or replace function public.notify_overdue_tasks()
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not notification_enabled('overdue_tasks') then return 0; end if;
  insert into notifications (user_id, title, body, type, link)
  select t.assigned_to, 'Task overdue', t.title || ' was due ' || to_char(t.due_date, 'DD Mon YYYY'), 'alert', '/tasks?task=' || t.id
  from tasks t
  where t.assigned_to is not null and t.status <> 'done' and t.due_date < current_date
    and not exists (select 1 from notifications n where n.user_id = t.assigned_to
                    and n.link = '/tasks?task=' || t.id and n.title = 'Task overdue'
                    and n.created_at::date = current_date);
  get diagnostics n = row_count;
  return n;
end $$;

select public.enable_audit('public.employees');
select public.enable_audit('public.employee_compensation');
select public.enable_audit('public.employee_assignments');
select public.enable_audit('public.attendance');
select public.enable_audit('public.leave_requests');
select public.enable_audit('public.payroll_records');
select public.enable_audit('public.client_invoices');
select public.enable_audit('public.financial_transactions');
select public.enable_audit('public.documents');
select public.enable_audit('public.document_versions');
select public.enable_audit('public.tasks');

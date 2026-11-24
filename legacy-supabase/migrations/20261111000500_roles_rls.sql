-- =============================================================================
-- ABCkit â€“ Default roles, permission matrix, Row Level Security
-- =============================================================================

insert into public.roles (key, name, description, is_system) values
  ('super_admin',          'Super Administrator',  'Full system access, including users, roles and settings', true),
  ('managing_director',    'Managing Director',    'Company-wide oversight, approvals and all reports', true),
  ('project_manager',      'Project Manager',      'Manages assigned projects end-to-end', true),
  ('site_engineer',        'Site Engineer',        'Daily site reporting and site operations for assigned projects', true),
  ('quantity_surveyor',    'Quantity Surveyor',    'BOQs, estimates, valuations and cost control', true),
  ('accountant',           'Accountant',           'Finance, payments, invoices and payroll processing', true),
  ('procurement_officer',  'Procurement Officer',  'Suppliers, requisitions, purchase orders', true),
  ('storekeeper',          'Storekeeper',          'Stores, stock receipts and issues', true),
  ('hr_officer',           'HR Officer',           'Employees, attendance, leave and payroll', true),
  ('employee',             'Employee',             'Basic self-service access', true);

insert into public.permissions (key, module, description) values
  ('dashboard.view',            'Dashboard',   'View dashboard'),
  ('projects.view',             'Projects',    'View projects they are assigned to'),
  ('projects.view_all',         'Projects',    'View every project (company-wide)'),
  ('projects.manage',           'Projects',    'Create and edit projects, manage teams'),
  ('projects.archive',          'Projects',    'Archive / restore projects'),
  ('clients.manage',            'Projects',    'Create and edit clients'),
  ('boq.view',                  'BOQ',         'View BOQs'),
  ('boq.manage',                'BOQ',         'Create and edit BOQs'),
  ('boq.approve',               'BOQ',         'Approve BOQs'),
  ('site.view',                 'Site',        'View site reports and operations'),
  ('site.report',               'Site',        'Submit daily site reports and incidents'),
  ('site.approve',              'Site',        'Approve / reject site reports'),
  ('inventory.view',            'Inventory',   'View materials and stock'),
  ('inventory.manage',          'Inventory',   'Register materials, receive and issue stock'),
  ('inventory.adjust',          'Inventory',   'Post stock adjustments'),
  ('inventory.approve_negative','Inventory',   'Authorise issues that take stock negative'),
  ('procurement.view',          'Procurement', 'View suppliers, requests and orders'),
  ('procurement.request',       'Procurement', 'Raise purchase requests'),
  ('procurement.manage',        'Procurement', 'Manage suppliers, purchase orders, GRNs, supplier invoices'),
  ('procurement.approve',       'Procurement', 'Approve purchase requests and orders'),
  ('equipment.view',            'Equipment',   'View equipment'),
  ('equipment.manage',          'Equipment',   'Manage equipment, usage logs and maintenance'),
  ('hr.view',                   'Workforce',   'View employee directory'),
  ('hr.manage',                 'Workforce',   'Manage employees, assignments, leave approval'),
  ('hr.attendance',             'Workforce',   'Record attendance and timesheets'),
  ('hr.payroll',                'Workforce',   'View and process confidential pay & payroll data'),
  ('finance.view',              'Finance',     'View financial records'),
  ('finance.manage',            'Finance',     'Record transactions and invoices'),
  ('finance.approve',           'Finance',     'Approve / void financial transactions'),
  ('documents.view',            'Documents',   'View and download documents'),
  ('documents.manage',          'Documents',   'Upload and edit documents'),
  ('documents.restricted',      'Documents',   'Access restricted / management-only documents'),
  ('tasks.view',                'Tasks',       'View tasks'),
  ('tasks.manage',              'Tasks',       'Create, assign and edit tasks'),
  ('reports.view',              'Reports',     'Operational reports'),
  ('reports.financial',         'Reports',     'Financial & profitability reports'),
  ('users.manage',              'Admin',       'Manage users, roles and permissions'),
  ('settings.manage',           'Admin',       'Manage system settings'),
  ('audit.view',                'Admin',       'View audit logs');

-- Permission matrix (super_admin is implicitly granted everything)
with matrix(role_key, perm_key) as (values
  -- Managing Director: everything except system administration
  ('managing_director','dashboard.view'),('managing_director','projects.view'),('managing_director','projects.view_all'),
  ('managing_director','projects.manage'),('managing_director','projects.archive'),('managing_director','clients.manage'),
  ('managing_director','boq.view'),('managing_director','boq.approve'),('managing_director','site.view'),('managing_director','site.approve'),
  ('managing_director','inventory.view'),('managing_director','inventory.approve_negative'),('managing_director','procurement.view'),
  ('managing_director','procurement.approve'),('managing_director','equipment.view'),('managing_director','hr.view'),
  ('managing_director','hr.payroll'),('managing_director','finance.view'),('managing_director','finance.approve'),
  ('managing_director','documents.view'),('managing_director','documents.manage'),('managing_director','documents.restricted'),
  ('managing_director','tasks.view'),('managing_director','tasks.manage'),('managing_director','reports.view'),
  ('managing_director','reports.financial'),('managing_director','audit.view'),
  -- Project Manager
  ('project_manager','dashboard.view'),('project_manager','projects.view'),('project_manager','projects.manage'),
  ('project_manager','clients.manage'),('project_manager','boq.view'),('project_manager','boq.manage'),
  ('project_manager','site.view'),('project_manager','site.report'),('project_manager','site.approve'),
  ('project_manager','inventory.view'),('project_manager','inventory.approve_negative'),('project_manager','procurement.view'),
  ('project_manager','procurement.request'),('project_manager','equipment.view'),('project_manager','equipment.manage'),('project_manager','hr.view'),
  ('project_manager','hr.attendance'),('project_manager','finance.view'),('project_manager','documents.view'),
  ('project_manager','documents.manage'),('project_manager','tasks.view'),('project_manager','tasks.manage'),
  ('project_manager','reports.view'),
  -- Site Engineer
  ('site_engineer','dashboard.view'),('site_engineer','projects.view'),('site_engineer','boq.view'),
  ('site_engineer','site.view'),('site_engineer','site.report'),('site_engineer','inventory.view'),
  ('site_engineer','procurement.request'),('site_engineer','equipment.view'),('site_engineer','hr.view'),
  ('site_engineer','hr.attendance'),('site_engineer','documents.view'),('site_engineer','documents.manage'),
  ('site_engineer','tasks.view'),('site_engineer','tasks.manage'),
  -- Quantity Surveyor
  ('quantity_surveyor','dashboard.view'),('quantity_surveyor','projects.view'),('quantity_surveyor','projects.view_all'),
  ('quantity_surveyor','boq.view'),('quantity_surveyor','boq.manage'),('quantity_surveyor','site.view'),
  ('quantity_surveyor','inventory.view'),('quantity_surveyor','procurement.view'),('quantity_surveyor','finance.view'),
  ('quantity_surveyor','documents.view'),('quantity_surveyor','documents.manage'),('quantity_surveyor','tasks.view'),
  ('quantity_surveyor','reports.view'),('quantity_surveyor','reports.financial'),
  -- Accountant
  ('accountant','dashboard.view'),('accountant','projects.view'),('accountant','projects.view_all'),('accountant','clients.manage'),
  ('accountant','boq.view'),('accountant','inventory.view'),('accountant','procurement.view'),('accountant','equipment.view'),
  ('accountant','hr.view'),('accountant','hr.payroll'),('accountant','finance.view'),('accountant','finance.manage'),
  ('accountant','finance.approve'),('accountant','documents.view'),('accountant','documents.manage'),
  ('accountant','tasks.view'),('accountant','reports.view'),('accountant','reports.financial'),
  -- Procurement Officer
  ('procurement_officer','dashboard.view'),('procurement_officer','projects.view'),('procurement_officer','projects.view_all'),
  ('procurement_officer','inventory.view'),('procurement_officer','procurement.view'),('procurement_officer','procurement.request'),
  ('procurement_officer','procurement.manage'),('procurement_officer','equipment.view'),('procurement_officer','equipment.manage'),('procurement_officer','documents.view'),
  ('procurement_officer','documents.manage'),('procurement_officer','tasks.view'),('procurement_officer','reports.view'),
  -- Storekeeper
  ('storekeeper','dashboard.view'),('storekeeper','projects.view'),('storekeeper','projects.view_all'),
  ('storekeeper','inventory.view'),('storekeeper','inventory.manage'),('storekeeper','procurement.view'),
  ('storekeeper','procurement.request'),('storekeeper','equipment.view'),('storekeeper','documents.view'),
  ('storekeeper','tasks.view'),('storekeeper','reports.view'),
  -- HR Officer
  ('hr_officer','dashboard.view'),('hr_officer','projects.view'),('hr_officer','projects.view_all'),('hr_officer','hr.view'),
  ('hr_officer','hr.manage'),('hr_officer','hr.attendance'),('hr_officer','hr.payroll'),('hr_officer','documents.view'),
  ('hr_officer','tasks.view'),('hr_officer','reports.view'),
  -- Employee
  ('employee','dashboard.view'),('employee','projects.view'),('employee','tasks.view'),('employee','documents.view')
)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from matrix m
join public.roles r on r.key = m.role_key
join public.permissions p on p.key = m.perm_key;

-- =============================================================================
-- Row Level Security
-- =============================================================================
do $$
declare t text;
begin
  foreach t in array array[
    'roles','permissions','role_permissions','profiles','company_settings','numbering_sequences','audit_logs',
    'notifications','clients','projects','project_members','boqs','boq_sections','boq_items',
    'site_reports','site_report_photos','safety_incidents','material_categories','materials','inventory_transactions',
    'suppliers','purchase_requests','purchase_request_items','purchase_orders','purchase_order_items',
    'goods_received','goods_received_items','supplier_invoices','equipment','equipment_assignments',
    'equipment_usage_logs','maintenance_records','employees','employee_compensation','employee_assignments',
    'attendance','leave_requests','payroll_records','client_invoices','financial_transactions',
    'documents','document_versions','tasks']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

-- ---- Admin / reference tables ----------------------------------------------
create policy roles_read on public.roles for select to authenticated using (public.is_active_user());
create policy roles_write on public.roles for all to authenticated
  using (public.has_permission('users.manage')) with check (public.has_permission('users.manage'));

create policy permissions_read on public.permissions for select to authenticated using (public.is_active_user());

create policy role_permissions_read on public.role_permissions for select to authenticated using (public.is_active_user());
create policy role_permissions_write on public.role_permissions for all to authenticated
  using (public.has_permission('users.manage')) with check (public.has_permission('users.manage'));

-- Profiles: everyone sees their own; active users see the staff directory (names/roles)
create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_active_user());
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
create policy profiles_update_admin on public.profiles for update to authenticated
  using (public.has_permission('users.manage')) with check (public.has_permission('users.manage'));

create policy settings_read on public.company_settings for select to authenticated using (true);
create policy settings_write on public.company_settings for update to authenticated
  using (public.has_permission('settings.manage')) with check (public.has_permission('settings.manage'));

create policy numbering_read on public.numbering_sequences for select to authenticated using (public.is_active_user());
create policy numbering_write on public.numbering_sequences for update to authenticated
  using (public.has_permission('settings.manage')) with check (public.has_permission('settings.manage'));

create policy audit_read on public.audit_logs for select to authenticated using (public.has_permission('audit.view'));
-- (no insert/update/delete policies: audit rows are written only by SECURITY DEFINER triggers)

create policy notifications_own on public.notifications for select to authenticated using (user_id = auth.uid());
create policy notifications_mark on public.notifications for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy notifications_delete on public.notifications for delete to authenticated using (user_id = auth.uid());

-- ---- Clients & projects ------------------------------------------------------
create policy clients_read on public.clients for select to authenticated using (public.has_permission('projects.view'));
create policy clients_write on public.clients for all to authenticated
  using (public.has_permission('clients.manage')) with check (public.has_permission('clients.manage'));

-- Row columns are checked directly so INSERT ... RETURNING works (the helper's subquery
-- cannot see the row being inserted in the same statement).
create policy projects_read on public.projects for select to authenticated
  using (public.has_permission('projects.view')
         and (project_manager_id = auth.uid() or created_by = auth.uid() or public.can_access_project(id)));
create policy projects_insert on public.projects for insert to authenticated
  with check (public.has_permission('projects.manage'));
create policy projects_update on public.projects for update to authenticated
  using (public.has_permission('projects.manage') and public.can_access_project(id))
  with check (public.has_permission('projects.manage'));
create policy projects_delete on public.projects for delete to authenticated
  using (public.current_role_key() = 'super_admin');

create policy members_read on public.project_members for select to authenticated
  using (public.can_access_project(project_id));
create policy members_write on public.project_members for all to authenticated
  using (public.has_permission('projects.manage') and public.can_access_project(project_id))
  with check (public.has_permission('projects.manage') and public.can_access_project(project_id));

-- ---- Generic project-scoped policies ----------------------------------------
-- Creates: read => has(view) & project access ; write => has(manage) & project access
create or replace function public._project_policies(tbl text, view_perm text, manage_perm text, project_expr text default 'project_id')
returns void language plpgsql as $$
begin
  execute format('create policy %1$s_read on public.%1$I for select to authenticated using (public.has_permission(%2$L) and public.can_access_project(%4$s))',
                 tbl, view_perm, manage_perm, project_expr);
  execute format('create policy %1$s_insert on public.%1$I for insert to authenticated with check (public.has_permission(%3$L) and public.can_access_project(%4$s))',
                 tbl, view_perm, manage_perm, project_expr);
  execute format('create policy %1$s_update on public.%1$I for update to authenticated using (public.has_permission(%3$L) and public.can_access_project(%4$s)) with check (public.has_permission(%3$L) and public.can_access_project(%4$s))',
                 tbl, view_perm, manage_perm, project_expr);
  execute format('create policy %1$s_delete on public.%1$I for delete to authenticated using (public.has_permission(%3$L) and public.can_access_project(%4$s))',
                 tbl, view_perm, manage_perm, project_expr);
end $$;

-- BOQ
select public._project_policies('boqs', 'boq.view', 'boq.manage');
select public._project_policies('boq_sections', 'boq.view', 'boq.manage',
  '(select b.project_id from public.boqs b where b.id = boq_id)');
select public._project_policies('boq_items', 'boq.view', 'boq.manage',
  '(select b.project_id from public.boqs b where b.id = boq_id)');
-- approvers need update rights on the BOQ header
create policy boqs_approve on public.boqs for update to authenticated
  using (public.has_permission('boq.approve') and public.can_access_project(project_id))
  with check (public.has_permission('boq.approve'));

-- Site reports: engineers edit their own non-approved reports; approvers review
create policy site_reports_read on public.site_reports for select to authenticated
  using (public.has_permission('site.view') and public.can_access_project(project_id));
create policy site_reports_insert on public.site_reports for insert to authenticated
  with check (public.has_permission('site.report') and public.can_access_project(project_id) and engineer_id = auth.uid());
create policy site_reports_update_own on public.site_reports for update to authenticated
  using (engineer_id = auth.uid() and status in ('draft','rejected','submitted') and public.has_permission('site.report'))
  with check (engineer_id = auth.uid() and public.can_access_project(project_id));
create policy site_reports_review on public.site_reports for update to authenticated
  using (public.has_permission('site.approve') and public.can_access_project(project_id))
  with check (public.has_permission('site.approve') and public.can_access_project(project_id));
create policy site_reports_delete on public.site_reports for delete to authenticated
  using ((engineer_id = auth.uid() and status = 'draft') or public.current_role_key() = 'super_admin');

create policy site_photos_read on public.site_report_photos for select to authenticated
  using (exists (select 1 from public.site_reports r where r.id = report_id
                 and public.has_permission('site.view') and public.can_access_project(r.project_id)));
create policy site_photos_write on public.site_report_photos for insert to authenticated
  with check (exists (select 1 from public.site_reports r where r.id = report_id
                      and (r.engineer_id = auth.uid() or public.has_permission('site.approve'))
                      and public.can_access_project(r.project_id)));
create policy site_photos_delete on public.site_report_photos for delete to authenticated
  using (created_by = auth.uid() or public.has_permission('site.approve'));

select public._project_policies('safety_incidents', 'site.view', 'site.report');

-- ---- Inventory -----------------------------------------------------------------
create policy material_categories_read on public.material_categories for select to authenticated using (public.is_active_user());
create policy material_categories_write on public.material_categories for all to authenticated
  using (public.has_permission('inventory.manage')) with check (public.has_permission('inventory.manage'));

create policy materials_read on public.materials for select to authenticated
  using (public.has_permission('inventory.view') or public.has_permission('procurement.view') or public.has_permission('site.report'));
create policy materials_write on public.materials for all to authenticated
  using (public.has_permission('inventory.manage') or public.has_permission('procurement.manage'))
  with check (public.has_permission('inventory.manage') or public.has_permission('procurement.manage'));

create policy inv_txn_read on public.inventory_transactions for select to authenticated
  using (public.has_permission('inventory.view') and (project_id is null or public.can_access_project(project_id)));
-- Storekeepers post movements; authorised approvers (PM / MD) may post an over-issue themselves
-- (the inventory_apply trigger still requires negative_override + inventory.approve_negative for that)
create policy inv_txn_insert on public.inventory_transactions for insert to authenticated
  with check ((public.has_permission('inventory.manage') or public.has_permission('inventory.approve_negative'))
              and (project_id is null or public.can_access_project(project_id)));

-- ---- Procurement ---------------------------------------------------------------
create policy suppliers_read on public.suppliers for select to authenticated
  using (public.has_permission('procurement.view') or public.has_permission('finance.view'));
create policy suppliers_write on public.suppliers for all to authenticated
  using (public.has_permission('procurement.manage')) with check (public.has_permission('procurement.manage'));

create policy pr_read on public.purchase_requests for select to authenticated
  using ((public.has_permission('procurement.view') and public.can_access_project(project_id)) or requested_by = auth.uid());
create policy pr_insert on public.purchase_requests for insert to authenticated
  with check (public.has_permission('procurement.request') and public.can_access_project(project_id) and requested_by = auth.uid());
create policy pr_update_own on public.purchase_requests for update to authenticated
  using (requested_by = auth.uid() and status in ('draft','submitted','rejected'))
  with check (requested_by = auth.uid());
create policy pr_update_mgr on public.purchase_requests for update to authenticated
  using (public.has_permission('procurement.manage') or public.has_permission('procurement.approve'))
  with check (public.has_permission('procurement.manage') or public.has_permission('procurement.approve'));
create policy pr_delete on public.purchase_requests for delete to authenticated
  using (requested_by = auth.uid() and status = 'draft');

create policy pr_items_read on public.purchase_request_items for select to authenticated
  using (exists (select 1 from public.purchase_requests r where r.id = request_id));
create policy pr_items_write on public.purchase_request_items for all to authenticated
  using (exists (select 1 from public.purchase_requests r where r.id = request_id
                 and ((r.requested_by = auth.uid() and r.status in ('draft','rejected')) or public.has_permission('procurement.manage'))))
  with check (exists (select 1 from public.purchase_requests r where r.id = request_id
                 and ((r.requested_by = auth.uid() and r.status in ('draft','rejected')) or public.has_permission('procurement.manage'))));

create policy po_read on public.purchase_orders for select to authenticated
  using ((public.has_permission('procurement.view') or public.has_permission('finance.view')
          or public.has_permission('inventory.manage')) and public.can_access_project(project_id));
create policy po_write on public.purchase_orders for insert to authenticated
  with check (public.has_permission('procurement.manage'));
create policy po_update on public.purchase_orders for update to authenticated
  using (public.has_permission('procurement.manage') or public.has_permission('procurement.approve'))
  with check (public.has_permission('procurement.manage') or public.has_permission('procurement.approve'));
create policy po_delete on public.purchase_orders for delete to authenticated
  using (public.has_permission('procurement.manage') and status = 'draft');

create policy po_items_read on public.purchase_order_items for select to authenticated
  using (exists (select 1 from public.purchase_orders o where o.id = po_id));
create policy po_items_write on public.purchase_order_items for all to authenticated
  using (public.has_permission('procurement.manage')) with check (public.has_permission('procurement.manage'));

create policy grn_read on public.goods_received for select to authenticated
  using ((public.has_permission('procurement.view') or public.has_permission('inventory.view')) and public.can_access_project(project_id));
create policy grn_insert on public.goods_received for insert to authenticated
  with check (public.has_permission('procurement.manage') or public.has_permission('inventory.manage'));
create policy grn_items_read on public.goods_received_items for select to authenticated
  using (exists (select 1 from public.goods_received g where g.id = grn_id));
create policy grn_items_insert on public.goods_received_items for insert to authenticated
  with check (public.has_permission('procurement.manage') or public.has_permission('inventory.manage'));

create policy sup_inv_read on public.supplier_invoices for select to authenticated
  using (public.has_permission('procurement.view') or public.has_permission('finance.view'));
create policy sup_inv_write on public.supplier_invoices for all to authenticated
  using (public.has_permission('procurement.manage') or public.has_permission('finance.manage'))
  with check (public.has_permission('procurement.manage') or public.has_permission('finance.manage'));

-- ---- Equipment -----------------------------------------------------------------
create policy equipment_read on public.equipment for select to authenticated using (public.has_permission('equipment.view'));
create policy equipment_write on public.equipment for all to authenticated
  using (public.has_permission('equipment.manage')) with check (public.has_permission('equipment.manage'));
select public._project_policies('equipment_assignments', 'equipment.view', 'equipment.manage');
create policy eq_usage_read on public.equipment_usage_logs for select to authenticated
  using (public.has_permission('equipment.view') and public.can_access_project(project_id));
create policy eq_usage_write on public.equipment_usage_logs for insert to authenticated
  with check ((public.has_permission('equipment.manage') or public.has_permission('site.report')) and public.can_access_project(project_id));
create policy eq_usage_modify on public.equipment_usage_logs for update to authenticated
  using (public.has_permission('equipment.manage')) with check (public.has_permission('equipment.manage'));
create policy eq_usage_delete on public.equipment_usage_logs for delete to authenticated
  using (public.has_permission('equipment.manage'));
create policy maint_read on public.maintenance_records for select to authenticated using (public.has_permission('equipment.view'));
create policy maint_write on public.maintenance_records for all to authenticated
  using (public.has_permission('equipment.manage')) with check (public.has_permission('equipment.manage'));

-- ---- Workforce -----------------------------------------------------------------
create policy employees_read on public.employees for select to authenticated
  using (public.has_permission('hr.view') or profile_id = auth.uid());
create policy employees_write on public.employees for all to authenticated
  using (public.has_permission('hr.manage')) with check (public.has_permission('hr.manage'));

-- Confidential: pay data only for payroll-authorised roles (or the employee themself, read-only)
create policy comp_read on public.employee_compensation for select to authenticated
  using (public.has_permission('hr.payroll')
         or exists (select 1 from public.employees e where e.id = employee_id and e.profile_id = auth.uid()));
create policy comp_write on public.employee_compensation for all to authenticated
  using (public.has_permission('hr.payroll')) with check (public.has_permission('hr.payroll'));

select public._project_policies('employee_assignments', 'hr.view', 'hr.manage');

create policy attendance_read on public.attendance for select to authenticated
  using ((public.has_permission('hr.view') and public.can_access_project(project_id))
         or exists (select 1 from public.employees e where e.id = employee_id and e.profile_id = auth.uid()));
create policy attendance_write on public.attendance for insert to authenticated
  with check (public.has_permission('hr.attendance') and public.can_access_project(project_id));
create policy attendance_update on public.attendance for update to authenticated
  using (public.has_permission('hr.attendance') and public.can_access_project(project_id))
  with check (public.has_permission('hr.attendance') and public.can_access_project(project_id));
create policy attendance_delete on public.attendance for delete to authenticated
  using (public.has_permission('hr.manage'));

create policy leave_read on public.leave_requests for select to authenticated
  using (public.has_permission('hr.view')
         or exists (select 1 from public.employees e where e.id = employee_id and e.profile_id = auth.uid()));
create policy leave_insert on public.leave_requests for insert to authenticated
  with check (public.has_permission('hr.manage')
              or exists (select 1 from public.employees e where e.id = employee_id and e.profile_id = auth.uid()));
create policy leave_update on public.leave_requests for update to authenticated
  using (public.has_permission('hr.manage')
         or (status = 'pending' and exists (select 1 from public.employees e where e.id = employee_id and e.profile_id = auth.uid())))
  with check (public.has_permission('hr.manage')
              or exists (select 1 from public.employees e where e.id = employee_id and e.profile_id = auth.uid()));

create policy payroll_read on public.payroll_records for select to authenticated
  using (public.has_permission('hr.payroll')
         or (status = 'paid' and exists (select 1 from public.employees e where e.id = employee_id and e.profile_id = auth.uid())));
create policy payroll_write on public.payroll_records for all to authenticated
  using (public.has_permission('hr.payroll')) with check (public.has_permission('hr.payroll'));

-- ---- Finance -------------------------------------------------------------------
create policy client_inv_read on public.client_invoices for select to authenticated
  using (public.has_permission('finance.view') and public.can_access_project(project_id));
create policy client_inv_write on public.client_invoices for all to authenticated
  using (public.has_permission('finance.manage')) with check (public.has_permission('finance.manage'));

create policy fin_read on public.financial_transactions for select to authenticated
  using (public.has_permission('finance.view') and public.can_access_project(project_id));
create policy fin_insert on public.financial_transactions for insert to authenticated
  with check (public.has_permission('finance.manage') and public.can_access_project(project_id));
create policy fin_update on public.financial_transactions for update to authenticated
  using (public.has_permission('finance.manage') or public.has_permission('finance.approve'))
  with check (public.has_permission('finance.manage') or public.has_permission('finance.approve'));

-- ---- Documents -----------------------------------------------------------------
create or replace function public.can_read_document(p_project uuid, p_access text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.has_permission('documents.view')
     and public.can_access_project(p_project)
     and (p_access = 'project'
          or (p_access = 'management' and (public.has_permission('documents.restricted') or public.has_permission('projects.view_all')))
          or (p_access = 'restricted' and public.has_permission('documents.restricted')))
$$;

create policy documents_read on public.documents for select to authenticated
  using (public.can_read_document(project_id, access_level));
create policy documents_insert on public.documents for insert to authenticated
  with check (public.has_permission('documents.manage') and public.can_access_project(project_id));
create policy documents_update on public.documents for update to authenticated
  using (public.has_permission('documents.manage') and public.can_read_document(project_id, access_level))
  with check (public.has_permission('documents.manage') and public.can_access_project(project_id));
create policy documents_delete on public.documents for delete to authenticated
  using (public.has_permission('documents.manage') and (created_by = auth.uid() or public.has_permission('documents.restricted')));

create policy doc_versions_read on public.document_versions for select to authenticated
  using (exists (select 1 from public.documents d where d.id = document_id));
create policy doc_versions_insert on public.document_versions for insert to authenticated
  with check (public.has_permission('documents.manage')
              and exists (select 1 from public.documents d where d.id = document_id));

-- ---- Tasks ---------------------------------------------------------------------
create policy tasks_read on public.tasks for select to authenticated
  using ((public.has_permission('tasks.view') and public.can_access_project(project_id)) or assigned_to = auth.uid());
create policy tasks_insert on public.tasks for insert to authenticated
  with check (public.has_permission('tasks.manage') and public.can_access_project(project_id));
create policy tasks_update on public.tasks for update to authenticated
  using ((public.has_permission('tasks.manage') and public.can_access_project(project_id)) or assigned_to = auth.uid())
  with check ((public.has_permission('tasks.manage') and public.can_access_project(project_id)) or assigned_to = auth.uid());
create policy tasks_delete on public.tasks for delete to authenticated
  using (public.has_permission('tasks.manage') and public.can_access_project(project_id));

drop function public._project_policies(text, text, text, text);

-- Function execution: helpers callable by signed-in users only
revoke execute on function public.next_number(text) from public, anon;
revoke execute on function public.notify_user(uuid, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.notify_permission(text, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.notify_overdue_tasks() from public, anon;
revoke execute on function public.enable_audit(regclass) from public, anon, authenticated;

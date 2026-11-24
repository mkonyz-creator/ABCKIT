-- =============================================================================
-- ABCkit DEMO DATA — for local development / training ONLY.
--
-- Every record is flagged is_demo = true and named with a "[DEMO]" prefix, and the
-- UI shows a "DEMO" badge on it. None of this is real company data.
-- `supabase db reset` loads this file automatically on a LOCAL stack.
-- NEVER run it against the production database (see README) — production starts empty.
-- =============================================================================

do $$
declare
  c1 uuid; c2 uuid; p1 uuid; p2 uuid; p3 uuid; s1 uuid; s2 uuid;
  m_cement uuid; m_sand uuid; m_y12 uuid; m_block uuid; m_diesel uuid;
  b1 uuid; sec_a uuid; sec_b uuid; sec_c uuid;
  e1 uuid; e2 uuid; e3 uuid; eq1 uuid; eq2 uuid; inv1 uuid;
  i int;
begin
  insert into clients (name, client_type, contact_person, phone, email, is_demo)
  values ('[DEMO] Kilimani Developers Ltd', 'company', 'Grace Mushi', '+255 700 000 001', 'demo.client@example.com', true) returning id into c1;
  insert into clients (name, client_type, contact_person, phone, is_demo)
  values ('[DEMO] Municipal Council (sample)', 'government', 'Procurement Unit', '+255 700 000 002', true) returning id into c2;

  insert into projects (name, client_id, location, region, start_date, end_date, contract_value, budget, status, progress, description, is_demo)
  values ('[DEMO] 4-Storey Office Block', c1, 'Plot 12, Mikocheni', 'Dar es Salaam', current_date - 150, current_date + 210, 2450000000, 2050000000, 'active', 38,
          'Sample project: reinforced concrete frame office building, 4 floors + roof.', true) returning id into p1;
  insert into projects (name, client_id, location, region, start_date, end_date, contract_value, budget, status, progress, is_demo)
  values ('[DEMO] Health Centre Renovation', c2, 'Kibaha', 'Pwani', current_date - 60, current_date + 60, 680000000, 590000000, 'active', 55, true) returning id into p2;
  insert into projects (name, client_id, location, region, start_date, end_date, contract_value, budget, status, progress, is_demo)
  values ('[DEMO] Warehouse Extension', c1, 'Mbezi', 'Dar es Salaam', current_date + 30, current_date + 240, 1200000000, 1010000000, 'planning', 0, true) returning id into p3;

  -- BOQ for project 1
  insert into boqs (project_id, title, is_demo) values (p1, '[DEMO] Main building – Contract BOQ', true) returning id into b1;
  insert into boq_sections (boq_id, code, title, sort_order) values (b1, 'A', 'Preliminaries', 1) returning id into sec_a;
  insert into boq_sections (boq_id, code, title, sort_order) values (b1, 'B', 'Substructure', 2) returning id into sec_b;
  insert into boq_sections (boq_id, code, title, sort_order) values (b1, 'C', 'Frame & slabs', 3) returning id into sec_c;
  insert into boq_items (section_id, item_code, description, unit, quantity, rate, sort_order) values
    (sec_a, 'A1', 'Site establishment, hoarding and temporary works', 'sum', 1, 45000000, 1),
    (sec_a, 'A2', 'Insurances and performance bond', 'sum', 1, 18500000, 2),
    (sec_b, 'B1', 'Excavate foundation trenches not exceeding 1.5 m deep', 'm³', 420, 9500, 1),
    (sec_b, 'B2', 'Blinding concrete C10, 50 mm thick', 'm²', 610, 14500, 2),
    (sec_b, 'B3', 'Reinforced concrete C25 in pad footings', 'm³', 96, 395000, 3),
    (sec_b, 'B4', 'High-yield steel bars Y12–Y16 in footings', 'kg', 7800, 3600, 4),
    (sec_c, 'C1', 'Reinforced concrete C25 in columns', 'm³', 88, 425000, 1),
    (sec_c, 'C2', 'Reinforced concrete C25 in suspended slabs 200 mm', 'm³', 540, 410000, 2),
    (sec_c, 'C3', 'Formwork to soffits of slabs', 'm²', 2700, 28500, 3);

  -- Materials & stock
  insert into materials (name, category_id, unit, unit_price, min_stock, is_demo)
  values ('[DEMO] Portland cement 42.5N (50 kg)', (select id from material_categories where name = 'Cement & Binders'), 'bag', 17500, 200, true) returning id into m_cement;
  insert into materials (name, category_id, unit, unit_price, min_stock, is_demo)
  values ('[DEMO] River sand', (select id from material_categories where name = 'Aggregates'), 'tonne', 38000, 40, true) returning id into m_sand;
  insert into materials (name, category_id, unit, unit_price, min_stock, is_demo)
  values ('[DEMO] Y12 deformed bar (12 m)', (select id from material_categories where name = 'Steel & Reinforcement'), 'pc', 26500, 150, true) returning id into m_y12;
  insert into materials (name, category_id, unit, unit_price, min_stock, is_demo)
  values ('[DEMO] Concrete block 150 mm', (select id from material_categories where name = 'Blocks & Bricks'), 'No.', 1450, 2000, true) returning id into m_block;
  insert into materials (name, category_id, unit, unit_price, min_stock, is_demo)
  values ('[DEMO] Diesel', (select id from material_categories where name = 'Fuel & Lubricants'), 'litre', 3150, 500, true) returning id into m_diesel;

  insert into inventory_transactions (material_id, txn_type, quantity, reference, transaction_date) values
    (m_cement, 'opening', 650, 'DEMO opening', current_date - 40), (m_sand, 'opening', 120, 'DEMO opening', current_date - 40),
    (m_y12, 'opening', 900, 'DEMO opening', current_date - 40), (m_block, 'opening', 9000, 'DEMO opening', current_date - 40),
    (m_diesel, 'opening', 1800, 'DEMO opening', current_date - 40);
  insert into inventory_transactions (material_id, project_id, txn_type, quantity, reference, transaction_date) values
    (m_cement, p1, 'issue', 420, 'DEMO issue', current_date - 20), (m_sand, p1, 'issue', 95, 'DEMO issue', current_date - 18),
    (m_y12, p1, 'issue', 610, 'DEMO issue', current_date - 15), (m_block, p2, 'issue', 3500, 'DEMO issue', current_date - 10),
    (m_diesel, p1, 'issue', 1450, 'DEMO issue', current_date - 5);

  -- Suppliers
  insert into suppliers (name, category, contact_person, phone, rating, payment_terms, is_demo)
  values ('[DEMO] Sample Cement Distributors', 'Cement & aggregates', 'J. Mollel', '+255 700 000 010', 4, '30 days', true) returning id into s1;
  insert into suppliers (name, category, contact_person, phone, rating, payment_terms, is_demo)
  values ('[DEMO] Sample Steel Traders', 'Steel', 'R. Patel', '+255 700 000 011', 3, '14 days', true) returning id into s2;

  -- Employees
  insert into employees (full_name, gender, position, department, employment_type, hire_date, phone, is_demo)
  values ('[DEMO] Juma Hamisi', 'male', 'Foreman', 'Site Operations', 'permanent', current_date - 900, '+255 700 000 101', true) returning id into e1;
  insert into employees (full_name, gender, position, department, employment_type, hire_date, is_demo)
  values ('[DEMO] Neema Joseph', 'female', 'Site Engineer', 'Engineering', 'permanent', current_date - 500, true) returning id into e2;
  insert into employees (full_name, gender, position, department, employment_type, hire_date, is_demo)
  values ('[DEMO] Baraka Said', 'male', 'Mason', 'Site Operations', 'casual', current_date - 120, true) returning id into e3;
  insert into employee_compensation (employee_id, pay_basis, basic_salary, overtime_rate) values (e1, 'monthly', 1200000, 7500), (e2, 'monthly', 2400000, 0);
  insert into employee_compensation (employee_id, pay_basis, daily_rate, overtime_rate) values (e3, 'daily', 25000, 4000);
  insert into employee_assignments (employee_id, project_id, role, start_date) values (e1, p1, 'Foreman', current_date - 150), (e3, p1, 'Mason', current_date - 120), (e2, p2, 'Site engineer', current_date - 60);
  for i in 1..12 loop
    insert into attendance (employee_id, project_id, work_date, status, hours_worked, overtime_hours)
    values (e1, p1, current_date - i, case when i % 7 = 0 then 'off' else 'present' end, case when i % 7 = 0 then 0 else 8 end, case when i % 3 = 0 then 2 else 0 end),
           (e3, p1, current_date - i, case when i % 5 = 0 then 'absent' else 'present' end, case when i % 5 = 0 then 0 else 8 end, 0);
  end loop;

  -- Equipment
  insert into equipment (name, category, make, model, registration_no, ownership, hourly_rate, status, is_demo)
  values ('[DEMO] Excavator 20t', 'earthmoving', 'Sample', 'EX200', 'T 000 AAA', 'owned', 95000, 'available', true) returning id into eq1;
  insert into equipment (name, category, make, model, ownership, hourly_rate, status, is_demo)
  values ('[DEMO] Concrete mixer 350L', 'concrete', 'Sample', 'CM350', 'owned', 12000, 'available', true) returning id into eq2;
  insert into equipment_assignments (equipment_id, project_id, start_date) values (eq1, p1, current_date - 30), (eq2, p1, current_date - 30);
  for i in 1..10 loop
    insert into equipment_usage_logs (equipment_id, project_id, usage_date, operator_name, hours_operated, idle_hours, fuel_litres, fuel_cost)
    values (eq1, p1, current_date - i, 'DEMO operator', 6 + (i % 3), 1, 85, 85 * 3150);
  end loop;
  insert into maintenance_records (equipment_id, maintenance_type, scheduled_date, completed_date, description, cost, downtime_hours, status, is_demo)
  values (eq1, 'scheduled', current_date - 25, current_date - 25, '[DEMO] 500-hour service', 1450000, 6, 'completed', true);

  -- Finance (approved demo history over 6 months; inserted without a user so status is kept)
  insert into client_invoices (project_id, invoice_type, invoice_date, amount, tax_amount, retention, description, is_demo)
  values (p1, 'interim_certificate', current_date - 35, 480000000, 86400000, 24000000, '[DEMO] Interim Payment Certificate No. 1', true) returning id into inv1;
  insert into financial_transactions (project_id, direction, category, amount, transaction_date, payment_method, payee_payer, description, client_invoice_id, status, is_demo)
  values (p1, 'income', 'advance_payment', 245000000, current_date - 140, 'bank_transfer', '[DEMO] Kilimani Developers', '[DEMO] 10% advance payment', null, 'approved', true),
         (p1, 'income', 'client_payment', 420000000, current_date - 20, 'bank_transfer', '[DEMO] Kilimani Developers', '[DEMO] Part payment IPC 1', inv1, 'approved', true),
         (p2, 'income', 'client_payment', 150000000, current_date - 15, 'bank_transfer', '[DEMO] Municipal Council', '[DEMO] IPC 1', null, 'approved', true);
  for i in 0..5 loop
    insert into financial_transactions (project_id, direction, category, amount, transaction_date, payment_method, payee_payer, description, status, is_demo) values
      (p1, 'expense', 'material', 38000000 + i * 4100000, (date_trunc('month', current_date) - make_interval(months => i))::date + 5, 'bank_transfer', '[DEMO] Supplier', '[DEMO] Materials purchase', 'approved', true),
      (p1, 'expense', 'labour', 21000000 + i * 1500000, (date_trunc('month', current_date) - make_interval(months => i))::date + 27, 'mobile_money', '[DEMO] Casual labour', '[DEMO] Labour payroll', 'approved', true),
      (p1, 'expense', 'equipment', 6500000, (date_trunc('month', current_date) - make_interval(months => i))::date + 12, 'cash', '[DEMO] Fuel station', '[DEMO] Plant fuel', 'approved', true),
      (p2, 'expense', 'material', 12000000 + i * 900000, (date_trunc('month', current_date) - make_interval(months => i))::date + 9, 'bank_transfer', '[DEMO] Supplier', '[DEMO] Materials', 'approved', true);
  end loop;
  insert into financial_transactions (project_id, direction, category, amount, payment_method, payee_payer, description, is_demo)
  values (p1, 'expense', 'petty_cash', 350000, 'cash', '[DEMO] Site office', '[DEMO] Stationery and drinking water', true);

  -- Tasks
  insert into tasks (project_id, title, priority, status, start_date, due_date, progress, is_milestone, is_demo) values
    (p1, '[DEMO] Complete first-floor slab casting', 'high', 'in_progress', current_date - 10, current_date + 5, 60, true, true),
    (p1, '[DEMO] Submit IPC No. 2 to consultant', 'medium', 'todo', current_date, current_date + 12, 0, false, true),
    (p1, '[DEMO] Renew building permit', 'critical', 'todo', current_date - 5, current_date - 1, 0, false, true),
    (p2, '[DEMO] Replace roofing sheets – Ward B', 'high', 'in_progress', current_date - 7, current_date + 9, 40, false, true);

  insert into safety_incidents (project_id, incident_date, severity, category, description, action_taken, status, is_demo)
  values (p1, current_date - 8, 'near_miss', 'Struck by object', '[DEMO] Unsecured plank fell from scaffold level 2; no injury.', 'Toe boards installed; toolbox talk held.', 'closed', true);
end $$;

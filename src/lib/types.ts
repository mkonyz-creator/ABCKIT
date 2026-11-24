export type UUID = string

export interface Role {
  id: UUID
  key: string
  name: string
  description: string | null
  is_system: boolean
}

export interface Profile {
  id: UUID
  full_name: string
  email: string
  phone: string | null
  job_title: string | null
  avatar_url: string | null
  role_id: UUID
  is_active: boolean
  last_seen_at: string | null
  created_at: string
  /** optional sign-in name (alternative to email) */
  username?: string | null
  role?: Pick<Role, 'id' | 'key' | 'name'> | null
}

export interface CompanySettings {
  id: 1
  company_name: string
  logo_url: string | null
  address: string | null
  phone: string | null
  email: string | null
  website: string | null
  tin: string | null
  default_currency: string
  currencies: Array<{ code: string; name: string; rate: number }>
  taxes: Array<{ name: string; rate: number }>
  units: string[]
  financial_year_start_month: number
  notification_settings: Record<string, boolean>
  updated_at: string
}

export type ProjectStatus = 'planning' | 'active' | 'on_hold' | 'completed' | 'cancelled'

export interface Client {
  id: UUID
  name: string
  client_type: string
  contact_person: string | null
  phone: string | null
  email: string | null
  address: string | null
  tin: string | null
  notes: string | null
  is_demo: boolean
}

export interface Project {
  id: UUID
  code: string
  name: string
  description: string | null
  client_id: UUID | null
  location: string | null
  region: string | null
  start_date: string | null
  end_date: string | null
  contract_value: number
  budget: number
  currency: string
  status: ProjectStatus
  progress: number
  project_manager_id: UUID | null
  cover_photo_path: string | null
  is_archived: boolean
  is_demo: boolean
  created_at: string
  updated_at: string
  client?: Pick<Client, 'id' | 'name'> | null
  manager?: Pick<Profile, 'id' | 'full_name'> | null
}

export interface ProjectFinancials {
  project_id: UUID
  code: string
  name: string
  status: ProjectStatus
  progress: number
  contract_value: number
  budget: number
  actual_cost: number
  income_received: number
  invoiced: number
  outstanding_receivable: number
  remaining_budget: number
  budget_used_pct: number
  boq_total: number
  net_cash: number
  is_archived: boolean
  is_demo: boolean
  start_date: string | null
  end_date: string | null
}

export interface Boq {
  id: UUID
  number: string
  project_id: UUID
  title: string
  description: string | null
  currency: string
  taxes: Array<{ name: string; rate: number }>
  status: 'draft' | 'submitted' | 'approved' | 'superseded'
  approved_by: UUID | null
  approved_at: string | null
  is_demo: boolean
  created_at: string
  updated_at: string
  project?: Pick<Project, 'id' | 'name' | 'code'> | null
}

export interface BoqSection {
  id: UUID
  boq_id: UUID
  code: string | null
  title: string
  sort_order: number
}

export interface BoqItem {
  id: UUID
  boq_id: UUID
  section_id: UUID
  item_code: string | null
  description: string
  unit: string
  quantity: number
  rate: number
  amount: number
  sort_order: number
}

export interface LineEntry {
  name: string
  quantity?: number
  unit?: string
  hours?: number
  count?: number
  material_id?: UUID
  equipment_id?: UUID
}

export interface SiteReport {
  id: UUID
  client_uuid: UUID | null
  number: string
  project_id: UUID
  report_date: string
  engineer_id: UUID
  weather: string | null
  temperature_c: number | null
  workers_count: number
  labour: Array<{ trade: string; count: number }>
  work_performed: string
  materials_used: LineEntry[]
  equipment_used: LineEntry[]
  progress_percent: number | null
  problems: string | null
  safety_observations: string | null
  safety_incidents: number
  recommendations: string | null
  engineer_comments: string | null
  signature_data: string | null
  status: 'draft' | 'submitted' | 'approved' | 'rejected'
  submitted_at: string | null
  approved_by: UUID | null
  approved_at: string | null
  review_comment: string | null
  is_demo: boolean
  created_at: string
  updated_at: string
  project?: Pick<Project, 'id' | 'name' | 'code'> | null
  engineer?: Pick<Profile, 'id' | 'full_name'> | null
  approver?: Pick<Profile, 'id' | 'full_name'> | null
}

export interface Material {
  id: UUID
  code: string
  name: string
  category_id: UUID | null
  unit: string
  unit_price: number
  min_stock: number
  current_stock: number
  description: string | null
  is_active: boolean
  is_demo: boolean
  category?: { id: UUID; name: string } | null
}

export interface Notification {
  id: UUID
  user_id: UUID
  title: string
  body: string | null
  type: 'info' | 'success' | 'warning' | 'alert' | 'task' | 'approval'
  link: string | null
  is_read: boolean
  created_at: string
}

export interface Task {
  id: UUID
  project_id: UUID | null
  parent_id: UUID | null
  title: string
  description: string | null
  assigned_to: UUID | null
  priority: 'low' | 'medium' | 'high' | 'critical'
  status: 'todo' | 'in_progress' | 'review' | 'blocked' | 'done'
  start_date: string | null
  due_date: string | null
  completed_at: string | null
  progress: number
  is_milestone: boolean
  is_demo: boolean
  created_at: string
  project?: Pick<Project, 'id' | 'name' | 'code'> | null
  assignee?: Pick<Profile, 'id' | 'full_name'> | null
}

export interface DashboardSummary {
  projects: {
    active: number
    completed: number
    pending: number
    on_hold: number
    total: number
    contract_value: number
    budget: number
    avg_progress: number
  }
  finance: null | {
    expenditure: number
    income: number
    remaining_budget: number
    receivable: number
    payable: number
    pending_approvals: number
  }
  inventory: null | {
    low_stock_count: number
    low_stock: Array<{ id: UUID; name: string; unit: string; current_stock: number; min_stock: number }>
    stock_value: number
  }
  workforce: null | { employees: number; present_today: number; absent_today: number; on_leave: number }
  progress: Array<{ id: UUID; code: string; name: string; progress: number; status: ProjectStatus; end_date: string | null }>
  deadlines: Array<{ kind: 'task' | 'project'; id: UUID; label: string; due: string; priority: string; project: string | null; status: string }>
  tasks: { open: number; overdue: number; mine: number }
  site: null | { pending_reports: number; reports_7d: number; open_incidents: number }
}

export interface ActivityItem {
  id: number
  table_name: string
  action: 'INSERT' | 'UPDATE' | 'DELETE'
  label: string
  project_id: UUID | null
  actor: string
  changed_at: string
}

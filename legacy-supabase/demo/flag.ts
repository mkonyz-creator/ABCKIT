/**
 * Demo mode: the whole backend (PostgreSQL + auth + storage) runs inside the browser via PGlite,
 * using the real migrations, RLS policies, triggers and the [DEMO] seed data.
 * Enabled from the "Open interactive demo" button (only shown when no Supabase project is configured)
 * or with VITE_DEMO_MODE=true. Never used when real Supabase credentials are present.
 */
const realConfigured = Boolean(import.meta.env.VITE_SUPABASE_URL && (import.meta.env.VITE_SUPABASE_ANON_KEY || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY))

function readFlag() {
  try {
    return localStorage.getItem('abckit-demo') === '1'
  } catch {
    return false
  }
}

export const IS_DEMO = import.meta.env.VITE_DEMO_MODE === 'true' || (!realConfigured && readFlag())
export const DEMO_URL = 'https://abckit.demo'
export const DEMO_PASSWORD = 'demo1234'

export const DEMO_ACCOUNTS = [
  { email: 'admin@demo.abckit', name: 'Asha Mollel', role: 'super_admin', label: 'Super Administrator' },
  { email: 'md@demo.abckit', name: 'Musa Kimaro', role: 'managing_director', label: 'Managing Director' },
  { email: 'pm@demo.abckit', name: 'Paula Shirima', role: 'project_manager', label: 'Project Manager' },
  { email: 'engineer@demo.abckit', name: 'Elia Mwanga', role: 'site_engineer', label: 'Site Engineer' },
  { email: 'qs@demo.abckit', name: 'Queen Lyimo', role: 'quantity_surveyor', label: 'Quantity Surveyor' },
  { email: 'accountant@demo.abckit', name: 'Amani Temba', role: 'accountant', label: 'Accountant' },
  { email: 'procurement@demo.abckit', name: 'Peter Ngowi', role: 'procurement_officer', label: 'Procurement Officer' },
  { email: 'store@demo.abckit', name: 'Saidi Juma', role: 'storekeeper', label: 'Storekeeper' },
  { email: 'hr@demo.abckit', name: 'Halima Omari', role: 'hr_officer', label: 'HR Officer' },
  { email: 'employee@demo.abckit', name: 'Juma Hamisi', role: 'employee', label: 'Employee' },
] as const

export function enterDemo() {
  try {
    localStorage.setItem('abckit-demo', '1')
  } catch {
    /* ignore */
  }
  location.reload()
}

export function exitDemo() {
  try {
    localStorage.removeItem('abckit-demo')
    localStorage.removeItem('abckit-auth')
  } catch {
    /* ignore */
  }
  location.href = location.pathname
}

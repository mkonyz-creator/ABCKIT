/**
 * Demo Mode switch.
 *
 * Demo Mode runs the complete app against an in-browser database (IndexedDB) filled with sample data
 * marked [DEMO]. It never contacts Firebase, and its sign-in is NOT a security boundary: anyone with the
 * browser can read or change demo data, and every demo account shares the published password below.
 * Production authentication (Firebase Auth) and production data are completely separate from it.
 *
 * Enabled by the "Try the demo" button on the sign-in page (stored per browser) or VITE_DEMO_MODE=true.
 */
const FLAG = 'abckit-demo'

function readFlag() {
  try {
    return localStorage.getItem(FLAG) === '1'
  } catch {
    return false
  }
}

export const IS_DEMO = import.meta.env.VITE_DEMO_MODE === 'true' || readFlag()

/** Published on the demo sign-in screen; demo accounts only exist inside the visitor's own browser. */
export const DEMO_PASSWORD = 'demo1234'

export interface DemoAccount {
  email: string
  username: string
  name: string
  role: string
  label: string
}

export const DEMO_ACCOUNTS: DemoAccount[] = [
  { email: 'admin@demo.abckit', username: 'demo.admin', name: 'Asha Mollel', role: 'super_admin', label: 'Super Administrator' },
  { email: 'administrator@demo.abckit', username: 'demo.sysadmin', name: 'Daudi Mrema', role: 'administrator', label: 'Administrator' },
  { email: 'md@demo.abckit', username: 'demo.md', name: 'Musa Kimaro', role: 'managing_director', label: 'Managing Director' },
  { email: 'pm@demo.abckit', username: 'demo.pm', name: 'Paula Shirima', role: 'project_manager', label: 'Project Manager' },
  { email: 'engineer@demo.abckit', username: 'demo.engineer', name: 'Elia Mwanga', role: 'site_engineer', label: 'Site Engineer' },
  { email: 'supervisor@demo.abckit', username: 'demo.supervisor', name: 'Rehema Massawe', role: 'site_supervisor', label: 'Site Supervisor' },
  { email: 'qs@demo.abckit', username: 'demo.qs', name: 'Queen Lyimo', role: 'quantity_surveyor', label: 'Quantity Surveyor' },
  { email: 'accountant@demo.abckit', username: 'demo.accountant', name: 'Amani Temba', role: 'accountant', label: 'Accountant' },
  { email: 'procurement@demo.abckit', username: 'demo.procurement', name: 'Peter Ngowi', role: 'procurement_officer', label: 'Procurement Officer' },
  { email: 'store@demo.abckit', username: 'demo.store', name: 'Saidi Juma', role: 'storekeeper', label: 'Storekeeper' },
  { email: 'hr@demo.abckit', username: 'demo.hr', name: 'Halima Omari', role: 'hr_officer', label: 'HR Officer' },
  { email: 'employee@demo.abckit', username: 'demo.employee', name: 'Joseph Lema', role: 'employee', label: 'Employee' },
]

function goToLogin() {
  window.location.replace(`${window.location.pathname}${window.location.search}#/login`)
  window.location.reload()
}

export function enterDemo() {
  try {
    localStorage.setItem(FLAG, '1')
  } catch {
    /* storage blocked: demo cannot persist */
  }
  goToLogin()
}

export function exitDemo() {
  try {
    localStorage.removeItem(FLAG)
    localStorage.removeItem('abckit-demo-session')
  } catch {
    /* ignore */
  }
  goToLogin()
}

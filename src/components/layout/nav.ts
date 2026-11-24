import {
  Bell,
  BookOpenCheck,
  Calculator,
  Boxes,
  CalendarCheck2,
  ClipboardList,
  FileStack,
  FolderKanban,
  HardHat,
  LayoutDashboard,
  Megaphone,
  type LucideIcon,
  PieChart,
  Settings,
  ShoppingCart,
  Sparkles,
  Tractor,
  Users,
  UserCog,
  Wallet,
} from 'lucide-react'
import { P } from '@/lib/permissions'

export interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  perm?: string | string[]
  group: 'Overview' | 'Projects' | 'Resources' | 'Business' | 'Admin'
}

export const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, perm: P.dashboard, group: 'Overview' },
  { to: '/ai', label: 'AI Intelligence', icon: Sparkles, perm: P.aiView, group: 'Overview' },
  { to: '/projects', label: 'Projects', icon: FolderKanban, perm: P.projectsView, group: 'Projects' },
  { to: '/boq', label: 'BOQ & Estimates', icon: BookOpenCheck, perm: P.boqView, group: 'Projects' },
  { to: '/site', label: 'Site Operations', icon: HardHat, perm: P.siteView, group: 'Projects' },
  { to: '/site-reports', label: 'Daily Site Reports', icon: ClipboardList, perm: [P.siteView, P.siteReport], group: 'Projects' },
  { to: '/tasks', label: 'Tasks & Scheduling', icon: CalendarCheck2, perm: P.tasksView, group: 'Projects' },
  { to: '/inventory', label: 'Materials & Inventory', icon: Boxes, perm: P.inventoryView, group: 'Resources' },
  { to: '/procurement', label: 'Procurement', icon: ShoppingCart, perm: [P.procurementView, P.procurementRequest], group: 'Resources' },
  { to: '/equipment', label: 'Equipment & Machinery', icon: Tractor, perm: P.equipmentView, group: 'Resources' },
  { to: '/workforce', label: 'Workforce & HR', icon: Users, perm: P.hrView, group: 'Resources' },
  { to: '/finance', label: 'Finance & Payments', icon: Wallet, perm: P.financeView, group: 'Business' },
  { to: '/accountant', label: 'Accountant Desk', icon: Calculator, perm: P.financeView, group: 'Business' },
  { to: '/documents', label: 'Documents', icon: FileStack, perm: P.documentsView, group: 'Business' },
  { to: '/reports', label: 'Reports & Analytics', icon: PieChart, perm: [P.reportsView, P.reportsFinancial], group: 'Business' },
  { to: '/notifications', label: 'Notifications', icon: Bell, group: 'Admin' },
  { to: '/report-to-admin', label: 'Report to Admin', icon: Megaphone, group: 'Admin' },
  { to: '/users', label: 'User Management', icon: UserCog, perm: P.usersManage, group: 'Admin' },
  { to: '/settings', label: 'System Settings', icon: Settings, perm: [P.settingsManage, P.auditView], group: 'Admin' },
]

export function allowed(item: { perm?: string | string[] }, can: (p: string) => boolean) {
  if (!item.perm) return true
  return Array.isArray(item.perm) ? item.perm.some(can) : can(item.perm)
}

import { ShieldAlert } from 'lucide-react'
import { lazy, Suspense, type ReactNode } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { AppShell } from '@/components/layout/AppShell'
import { PwaPrompt } from '@/components/layout/PwaPrompt'
import { EmptyState, Spinner } from '@/components/ui/misc'
import { P } from '@/lib/permissions'
import { isBackendConfigured } from '@/lib/backend'
import { useAuth } from '@/providers/AuthProvider'
import { ForgotPasswordPage, InactivePage, LoginPage, ResetPasswordPage, SetupRequiredPage } from '@/pages/auth/AuthPages'

const Dashboard = lazy(() => import('@/pages/dashboard/DashboardPage'))
const ProjectsPage = lazy(() => import('@/pages/projects/ProjectsPage'))
const ProjectWorkspace = lazy(() => import('@/pages/projects/ProjectWorkspace'))
const BoqListPage = lazy(() => import('@/pages/boq/BoqListPage'))
const BoqEditorPage = lazy(() => import('@/pages/boq/BoqEditorPage'))
const SiteOperationsPage = lazy(() => import('@/pages/site/SiteOperationsPage'))
const SiteReportsPage = lazy(() => import('@/pages/site/SiteReportsPage'))
const SiteReportFormPage = lazy(() => import('@/pages/site/SiteReportFormPage'))
const SiteReportViewPage = lazy(() => import('@/pages/site/SiteReportViewPage'))
const InventoryPage = lazy(() => import('@/pages/inventory/InventoryPage'))
const AccountantPage = lazy(() => import('@/pages/finance/AccountantPage'))
const ProcurementPage = lazy(() => import('@/pages/procurement/ProcurementPage'))
const EquipmentPage = lazy(() => import('@/pages/equipment/EquipmentPage'))
const WorkforcePage = lazy(() => import('@/pages/workforce/WorkforcePage'))
const FinancePage = lazy(() => import('@/pages/finance/FinancePage'))
const DocumentsPage = lazy(() => import('@/pages/documents/DocumentsPage'))
const TasksPage = lazy(() => import('@/pages/tasks/TasksPage'))
const ReportsPage = lazy(() => import('@/pages/reports/ReportsPage'))
const NotificationsPage = lazy(() => import('@/pages/admin/NotificationsPage'))
const ReportToAdminPage = lazy(() => import('@/pages/admin/ReportToAdminPage'))
const UsersPage = lazy(() => import('@/pages/admin/UsersPage'))
const SettingsPage = lazy(() => import('@/pages/admin/SettingsPage'))
const ProfilePage = lazy(() => import('@/pages/admin/ProfilePage'))
const AiPage = lazy(() => import('@/pages/ai/AiPage'))

function RequireAuth({ children }: { children: ReactNode }) {
  const { session, loading, profile } = useAuth()
  const location = useLocation()
  if (loading) return <Spinner className="min-h-dvh" label="Loading ABCkit" />
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname }} />
  if (!profile || !profile.is_active) return <InactivePage />
  return <>{children}</>
}

function Guard({ perm, children }: { perm: string | string[]; children: ReactNode }) {
  const { can } = useAuth()
  const ok = Array.isArray(perm) ? perm.some(can) : can(perm)
  if (!ok)
    return (
      <EmptyState
        icon={<ShieldAlert className="size-6" />}
        title="Access restricted"
        description="Your role does not include access to this module. Contact your administrator if you need it."
      />
    )
  return <>{children}</>
}

export default function App() {
  const { session } = useAuth()
  if (!isBackendConfigured) return <SetupRequiredPage />

  return (
    <>
      <PwaPrompt />
      <Suspense fallback={<Spinner className="min-h-[50vh]" />}>
        <Routes>
          <Route path="/login" element={session ? <Navigate to="/" replace /> : <LoginPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route
            element={
              <RequireAuth>
                <AppShell />
              </RequireAuth>
            }
          >
            <Route index element={<Guard perm={P.dashboard}><Dashboard /></Guard>} />
            <Route path="ai" element={<Guard perm={P.aiView}><AiPage /></Guard>} />
            <Route path="projects" element={<Guard perm={P.projectsView}><ProjectsPage /></Guard>} />
            <Route path="projects/:id" element={<Guard perm={P.projectsView}><ProjectWorkspace /></Guard>} />
            <Route path="boq" element={<Guard perm={P.boqView}><BoqListPage /></Guard>} />
            <Route path="boq/:id" element={<Guard perm={P.boqView}><BoqEditorPage /></Guard>} />
            <Route path="site" element={<Guard perm={P.siteView}><SiteOperationsPage /></Guard>} />
            <Route path="site-reports" element={<Guard perm={[P.siteView, P.siteReport]}><SiteReportsPage /></Guard>} />
            <Route path="site-reports/new" element={<Guard perm={P.siteReport}><SiteReportFormPage /></Guard>} />
            <Route path="site-reports/draft/:draftKey" element={<Guard perm={P.siteReport}><SiteReportFormPage /></Guard>} />
            <Route path="site-reports/:id/edit" element={<Guard perm={P.siteReport}><SiteReportFormPage /></Guard>} />
            <Route path="site-reports/:id" element={<Guard perm={[P.siteView, P.siteReport]}><SiteReportViewPage /></Guard>} />
            <Route path="tasks" element={<Guard perm={P.tasksView}><TasksPage /></Guard>} />
            <Route path="inventory" element={<Guard perm={P.inventoryView}><InventoryPage /></Guard>} />
            <Route path="procurement" element={<Guard perm={[P.procurementView, P.procurementRequest]}><ProcurementPage /></Guard>} />
            <Route path="equipment" element={<Guard perm={P.equipmentView}><EquipmentPage /></Guard>} />
            <Route path="workforce" element={<Guard perm={P.hrView}><WorkforcePage /></Guard>} />
            <Route path="finance" element={<Guard perm={P.financeView}><FinancePage /></Guard>} />
            <Route path="accountant" element={<Guard perm={P.financeView}><AccountantPage /></Guard>} />
            <Route path="documents" element={<Guard perm={P.documentsView}><DocumentsPage /></Guard>} />
            <Route path="reports" element={<Guard perm={[P.reportsView, P.reportsFinancial]}><ReportsPage /></Guard>} />
            <Route path="notifications" element={<NotificationsPage />} />
            <Route path="report-to-admin" element={<ReportToAdminPage />} />
            <Route path="users" element={<Guard perm={P.usersManage}><UsersPage /></Guard>} />
            <Route path="settings" element={<Guard perm={[P.settingsManage, P.auditView]}><SettingsPage /></Guard>} />
            <Route path="profile" element={<ProfilePage />} />
            <Route path="*" element={<EmptyState title="Page not found" description="The page you requested does not exist." />} />
          </Route>
        </Routes>
      </Suspense>
    </>
  )
}

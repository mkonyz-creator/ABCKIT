import { Bell, Bot, FileText, FolderKanban, History, LayoutDashboard, Mail, Settings2, Sparkles } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { Badge, PageHeader, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/misc'
import { IS_DEMO } from '@/lib/backend'
import { useAuth } from '@/providers/AuthProvider'
import { ActivityTab } from './ActivityTab'
import { AlertsTab } from './AlertsTab'
import { ChatTab } from './ChatTab'
import { EmailTab } from './EmailTab'
import { OverviewTab } from './OverviewTab'
import { ProjectsTab } from './ProjectsTab'
import { ReportsTab } from './ReportsTab'
import { SettingsTab } from './SettingsTab'
import { useAiInvalidate, useAiLive } from './useAi'

const TABS: Array<{ value: string; label: string; icon: ReactNode; perm?: string; render: () => ReactNode }> = [
  { value: 'overview', label: 'Executive Overview', icon: <LayoutDashboard />, render: () => <OverviewTab /> },
  { value: 'email', label: 'Email Intelligence', icon: <Mail />, perm: 'ai.email', render: () => <EmailTab /> },
  { value: 'chat', label: 'AI Assistant', icon: <Bot />, render: () => <ChatTab /> },
  { value: 'projects', label: 'Project Intelligence', icon: <FolderKanban />, render: () => <ProjectsTab /> },
  { value: 'alerts', label: 'Operational Alerts', icon: <Bell />, render: () => <AlertsTab /> },
  { value: 'reports', label: 'AI Reports', icon: <FileText />, render: () => <ReportsTab /> },
  { value: 'activity', label: 'Activity History', icon: <History />, render: () => <ActivityTab /> },
  { value: 'settings', label: 'AI Settings', icon: <Settings2 />, perm: 'ai.manage', render: () => <SettingsTab /> },
]

export default function AiPage() {
  const { can } = useAuth()
  const [params, setParams] = useSearchParams()
  const invalidate = useAiInvalidate()
  useAiLive()
  const visible = TABS.filter((t) => !t.perm || can(t.perm))
  const requested = params.get('tab') ?? 'overview'
  const tab = TABS.some((t) => t.value === requested) ? requested : 'overview'

  // return from the mailbox OAuth consent screen: #/ai?tab=settings&connected=gmail | &error=…
  useEffect(() => {
    const connected = params.get('connected')
    const error = params.get('error')
    if (!connected && !error) return
    if (connected) {
      toast.success(`${connected === 'microsoft' ? 'Microsoft 365' : connected === 'gmail' ? 'Gmail' : connected} mailbox connected — the first sync starts shortly`)
      void invalidate('email_accounts', 'ai_status')
    } else toast.error(`Mailbox not connected: ${error}`)
    const next = new URLSearchParams(params)
    next.delete('connected')
    next.delete('error')
    setParams(next, { replace: true })
  }, [params, setParams, invalidate])

  return (
    <div>
      <div className="no-print">
        <PageHeader
          title={
            <span className="flex flex-wrap items-center gap-2">
              <Sparkles className="size-6 text-accent" /> AI Intelligence
              {IS_DEMO && <Badge tone="warning">[DEMO] no AI model</Badge>}
            </span>
          }
          description="Executive overview, email intelligence, assistant, alerts and reports — built only from the records your role can see."
        />
      </div>
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v })}>
        <div className="no-print">
          <TabsList>
            {visible.map((t) => (
              <TabsTrigger key={t.value} value={t.value}>
                {t.icon} {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        {TABS.map((t) => (
          <TabsContent key={t.value} value={t.value}>
            {tab === t.value ? t.render() : null}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  )
}

/**
 * Roles added on top of the original 10 (requested: "Administrator" and "Site Supervisor").
 * They are created at bootstrap like the others and remain editable in User Management → Roles & permissions.
 */
export const EXTRA_ROLES: Array<{ key: string; name: string; description: string; perms: string[] }> = [
  {
    key: 'administrator',
    name: 'Administrator',
    description: 'System administration (users, roles, settings, audit) with read access to all modules',
    perms: [
      'dashboard.view', 'projects.view', 'projects.view_all', 'boq.view', 'site.view', 'inventory.view',
      'procurement.view', 'equipment.view', 'hr.view', 'finance.view', 'documents.view', 'tasks.view',
      'reports.view', 'users.manage', 'settings.manage', 'audit.view',
    ],
  },
  {
    key: 'site_supervisor',
    name: 'Site Supervisor',
    description: 'Supervises work on assigned sites: daily reports, attendance, tasks and material requests',
    perms: [
      'dashboard.view', 'projects.view', 'boq.view', 'site.view', 'site.report', 'inventory.view',
      'procurement.request', 'equipment.view', 'hr.view', 'hr.attendance', 'documents.view', 'tasks.view', 'tasks.manage',
    ],
  },
]

/** Permissions added for ABCkit AI Intelligence (see src/shared/ai/contract.ts AI_PERMS). */
export const EXTRA_PERMISSIONS: Array<{ key: string; module: string; description: string }> = [
  { key: 'ai.view', module: 'AI', description: 'AI executive dashboard, alerts, reports and chat assistant' },
  { key: 'ai.email', module: 'AI', description: 'Read company email intelligence and prepare reply drafts' },
  { key: 'ai.email_send', module: 'AI', description: 'Approve and send email replies' },
  { key: 'ai.manage', module: 'AI', description: 'AI Control Center: email accounts, AI settings, knowledge, usage and audit' },
]

/** Grants of the AI permissions to existing roles (super_admin has every permission implicitly). */
export const EXTRA_GRANTS: Array<[role: string, perm: string]> = [
  ['managing_director', 'ai.view'],
  ['managing_director', 'ai.email'],
  ['managing_director', 'ai.email_send'],
  ['administrator', 'ai.view'],
  ['administrator', 'ai.manage'],
]

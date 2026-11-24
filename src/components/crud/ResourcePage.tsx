import { Archive, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { DataTable, type Column, type FilterDef } from '@/components/data/DataTable'
import { Button } from '@/components/ui/button'
import { ConfirmDialog, Dialog } from '@/components/ui/dialog'
import { Card, Menu, MenuContent, MenuItem, MenuTrigger, MenuSeparator } from '@/components/ui/misc'
import { useList, useRemove, useSave, type Eq } from '@/lib/hooks'
import { useAuth } from '@/providers/AuthProvider'
import { ResourceForm, toFormValues, type FieldDef } from './ResourceForm'

export interface ResourceConfig<T> {
  table: string
  /** table/view to read from (defaults to table) */
  readFrom?: string
  select?: string
  singular: string
  plural: string
  columns: Column<T>[]
  fields: FieldDef[]
  filters?: FilterDef<T>[]
  order?: { column: string; ascending?: boolean }
  eq?: Eq
  /** values injected on create (e.g. project_id) */
  createDefaults?: Record<string, any>
  perms: { create?: string; edit?: string; remove?: string }
  /** archive instead of delete */
  archive?: { field: string; label?: string }
  canEditRow?: (row: T) => boolean
  canDeleteRow?: (row: T) => boolean
  beforeSave?: (values: Record<string, any>, editing: T | null) => Record<string, any>
  /** map a stored row onto form field names before editing */
  beforeEdit?: (row: T) => Record<string, any>
  onRowClick?: (row: T) => void
  extraActions?: (row: T) => ReactNode
  toolbar?: ReactNode
  invalidate?: string[]
  emptyDescription?: string
  dialogSize?: 'sm' | 'md' | 'lg' | 'xl'
  rowKey?: (row: T) => string
  initialSort?: { key: string; dir: 'asc' | 'desc' }
  hideCreate?: boolean
  initialFilters?: Record<string, string>
  initialSearch?: string
  /** open the create dialog on mount (e.g. ?new=1) */
  openCreate?: boolean
}

export function ResourcePage<T extends { id?: string; is_demo?: boolean }>({ config }: { config: ResourceConfig<T> }) {
  const { can } = useAuth()
  const list = useList<T>(config.readFrom ?? config.table, { select: config.select, eq: config.eq, order: config.order })
  const save = useSave(config.table, { invalidate: [...(config.invalidate ?? []), ...(config.readFrom ? [config.readFrom] : [])] })
  const remove = useRemove(config.table, { invalidate: config.readFrom ? [config.readFrom] : [] })
  const [editing, setEditing] = useState<T | null>(null)
  const [open, setOpen] = useState(!!config.openCreate)
  const [confirm, setConfirm] = useState<T | null>(null)

  const canCreate = !config.hideCreate && (!config.perms.create || can(config.perms.create))
  const canEdit = !config.perms.edit || can(config.perms.edit)
  const canRemove = config.perms.remove ? can(config.perms.remove) : false

  const initial = useMemo(() => toFormValues(config.fields, editing ? (config.beforeEdit ? config.beforeEdit(editing) : (editing as any)) : null, config.createDefaults),
    // recompute only when the dialog opens or the edited row changes (config objects are often inline)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editing, open],
  )

  const formId = `form-${config.table}`
  const submit = (values: Record<string, any>) => {
    let payload = editing ? values : { ...config.createDefaults, ...values }
    if (config.beforeSave) payload = config.beforeSave(payload, editing)
    save.mutate(
      { id: editing?.id, values: payload },
      {
        onSuccess: () => {
          setOpen(false)
          setEditing(null)
        },
      },
    )
  }

  const actions = (row: T) => {
    const editable = canEdit && (config.canEditRow?.(row) ?? true)
    const deletable = canRemove && (config.canDeleteRow?.(row) ?? true)
    const extra = config.extraActions?.(row)
    if (!editable && !deletable && !extra) return null
    return (
      <Menu>
        <MenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Row actions">
            <MoreHorizontal />
          </Button>
        </MenuTrigger>
        <MenuContent>
          {editable && (
            <MenuItem
              onSelect={() => {
                setEditing(row)
                setOpen(true)
              }}
            >
              <Pencil /> Edit
            </MenuItem>
          )}
          {extra}
          {deletable && (
            <>
              <MenuSeparator />
              <MenuItem danger onSelect={() => setConfirm(row)}>
                {config.archive ? <Archive /> : <Trash2 />} {config.archive?.label ?? 'Delete'}
              </MenuItem>
            </>
          )}
        </MenuContent>
      </Menu>
    )
  }

  return (
    <Card>
      <DataTable<T>
        rows={list.data}
        loading={list.isLoading}
        error={list.error}
        onRetry={() => list.refetch()}
        columns={config.columns}
        filters={config.filters}
        rowKey={config.rowKey ?? ((r) => r.id as string)}
        isDemo={(r) => !!r.is_demo}
        onRowClick={config.onRowClick}
        rowActions={actions}
        exportTitle={config.plural}
        emptyTitle={`No ${config.plural.toLowerCase()} yet`}
        emptyDescription={config.emptyDescription}
        initialSort={config.initialSort}
        initialFilters={config.initialFilters}
        initialSearch={config.initialSearch}
        searchPlaceholder={`Search ${config.plural.toLowerCase()}…`}
        emptyAction={
          canCreate ? (
            <Button
              variant="primary"
              onClick={() => {
                setEditing(null)
                setOpen(true)
              }}
            >
              <Plus /> Add {config.singular.toLowerCase()}
            </Button>
          ) : undefined
        }
        toolbar={
          <>
            {config.toolbar}
            {canCreate && (
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  setEditing(null)
                  setOpen(true)
                }}
              >
                <Plus /> New {config.singular.toLowerCase()}
              </Button>
            )}
          </>
        }
      />

      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o)
          if (!o) setEditing(null)
        }}
        title={editing ? `Edit ${config.singular.toLowerCase()}` : `New ${config.singular.toLowerCase()}`}
        size={config.dialogSize ?? 'lg'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" form={formId} loading={save.isPending}>
              {editing ? 'Save changes' : `Create ${config.singular.toLowerCase()}`}
            </Button>
          </>
        }
      >
        <ResourceForm id={formId} fields={config.fields} initial={initial} editing={!!editing} onSubmit={submit} />
      </Dialog>

      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={config.archive ? `${config.archive.label ?? 'Archive'} ${config.singular.toLowerCase()}?` : `Delete ${config.singular.toLowerCase()}?`}
        message={config.archive ? 'The record will be hidden from active lists but kept for history.' : 'This permanently deletes the record. This cannot be undone.'}
        confirmLabel={config.archive?.label ?? 'Delete'}
        danger
        loading={remove.isPending || save.isPending}
        onConfirm={() => {
          if (!confirm) return
          if (config.archive) {
            save.mutate({ id: confirm.id, values: { [config.archive.field]: true } }, { onSuccess: () => setConfirm(null) })
          } else {
            remove.mutate(confirm.id as string, { onSuccess: () => setConfirm(null) })
          }
        }}
      />
    </Card>
  )
}
